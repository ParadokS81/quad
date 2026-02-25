import { createWriteStream, statSync, type WriteStream } from 'node:fs';
import { type Readable } from 'node:stream';
import { once } from 'node:events';
import prism from 'prism-media';
import { logger } from '../../core/logger.js';
import { SILENT_OPUS_FRAME, FRAME_DURATION_MS } from './silence.js';

/** Max valid Opus packet size per RFC 6716 */
const MAX_OPUS_PACKET_SIZE = 1275;

/** DAVE protocol magic marker — last 2 bytes of an undecrypted DAVE frame */
const DAVE_MAGIC = 0xfafa;

/**
 * Validate an Opus packet. Returns true if the packet looks like valid Opus,
 * false if it's likely corrupt (e.g. undecrypted DAVE ciphertext).
 *
 * Checks:
 * 1. Non-empty and within RFC 6716 size limits
 * 2. Not an undecrypted DAVE frame (trailing 0xFAFA magic marker)
 * 3. TOC byte frame count code is valid (bits 0-1 must be 0-3, which is always true,
 *    but code=3 VBR packets must have at least 2 bytes for the frame count header)
 */
function isValidOpusPacket(packet: Buffer): boolean {
  const len = packet.length;
  if (len === 0 || len > MAX_OPUS_PACKET_SIZE) return false;

  // DAVE passthrough detection: encrypted frames end with 0xFAFA magic marker
  if (len >= 4 && packet.readUInt16BE(len - 2) === DAVE_MAGIC) return false;

  // TOC byte code=3 (arbitrary CBR/VBR) requires at least 2 bytes
  const code = packet[0] & 0x03;
  if (code === 3 && len < 2) return false;

  return true;
}

export class UserTrack {
  readonly trackNumber: number;
  readonly userId: string;
  readonly username: string;
  readonly displayName: string;
  readonly filePath: string;
  readonly audioFile: string;
  readonly joinedAt: Date;
  leftAt: Date | null = null;

  private oggStream: prism.opus.OggLogicalBitstream;
  private fileStream: WriteStream;
  private opusStream: Readable | null = null;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private lastPacketTime = 0;
  private framesWritten = 0;
  private trackStartTime = 0;
  private recordingStartTime: Date;
  private failed = false;

  // Packet validation stats
  private validPackets = 0;
  private corruptPackets = 0;
  private corruptLoggedAt = 0; // timestamp of first corruption log (avoid spam)

  constructor(opts: {
    trackNumber: number;
    userId: string;
    username: string;
    displayName: string;
    outputDir: string;
    recordingStartTime: Date;
  }) {
    this.trackNumber = opts.trackNumber;
    this.userId = opts.userId;
    this.username = opts.username;
    this.displayName = opts.displayName;
    this.joinedAt = new Date();
    this.recordingStartTime = opts.recordingStartTime;

    this.audioFile = `${opts.trackNumber}-${opts.username}.ogg`;
    this.filePath = `${opts.outputDir}/${this.audioFile}`;

    this.oggStream = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({
        channelCount: 2,
        sampleRate: 48000,
      }),
      pageSizeControl: { maxPackets: 10 },
      crc: true,
    });

    this.fileStream = createWriteStream(this.filePath);

    this.fileStream.on('error', (err) => {
      logger.error(`File write error for track ${this.trackNumber} (${this.username})`, {
        error: err.message,
        filePath: this.filePath,
      });
      this.closeOnError();
    });

    this.oggStream.on('error', (err) => {
      logger.error(`OGG stream error for track ${this.trackNumber} (${this.username})`, {
        error: err.message,
      });
      this.closeOnError();
    });

    // Pipe OGG output to file
    this.oggStream.pipe(this.fileStream);

    logger.debug(`Track ${this.trackNumber} created: ${this.audioFile}`, {
      userId: this.userId,
      filePath: this.filePath,
    });
  }

  /** Whether this track has been closed due to an error */
  get isFailed(): boolean {
    return this.failed;
  }

  start(opusStream: Readable): void {
    this.opusStream = opusStream;

    // Prepend silence for late joiners (align to recording start)
    const gapMs = this.joinedAt.getTime() - this.recordingStartTime.getTime();
    if (gapMs > FRAME_DURATION_MS) {
      const silentFrames = Math.floor(gapMs / FRAME_DURATION_MS);
      for (let i = 0; i < silentFrames; i++) {
        this.oggStream.write(SILENT_OPUS_FRAME);
      }
      this.framesWritten += silentFrames;
      logger.debug(`Track ${this.trackNumber} prepended ${silentFrames} silent frames (${gapMs}ms gap)`, {
        username: this.username,
      });
    }

    // Track start time = recording start (frames are counted from here)
    this.trackStartTime = this.recordingStartTime.getTime();

    // Listen for real packets — validate before writing to OGG
    this.lastPacketTime = Date.now();
    opusStream.on('data', (packet: Buffer) => {
      if (this.failed) return;
      this.lastPacketTime = Date.now();
      this.framesWritten++;

      if (isValidOpusPacket(packet)) {
        this.validPackets++;
        this.oggStream.write(packet);
      } else {
        this.corruptPackets++;
        this.oggStream.write(SILENT_OPUS_FRAME);

        // Log first corruption event per track, then periodic summaries
        const now = Date.now();
        if (this.corruptPackets === 1) {
          this.corruptLoggedAt = now;
          logger.warn(`Corrupt Opus packet detected — replacing with silence`, {
            track: this.trackNumber,
            username: this.username,
            packetLen: packet.length,
            firstBytes: packet.subarray(0, Math.min(8, packet.length)).toString('hex'),
            lastBytes: packet.length >= 4 ? packet.subarray(packet.length - 4).toString('hex') : '',
            isDavePassthrough: packet.length >= 4 && packet.readUInt16BE(packet.length - 2) === DAVE_MAGIC,
          });
        } else if (now - this.corruptLoggedAt > 30_000) {
          // Summary every 30s while corruption is ongoing
          this.corruptLoggedAt = now;
          logger.warn(`Opus corruption ongoing`, {
            track: this.trackNumber,
            username: this.username,
            corruptTotal: this.corruptPackets,
            validTotal: this.validPackets,
          });
        }
      }
    });

    opusStream.on('error', (err) => {
      logger.warn(`Opus stream error for ${this.username} (track ${this.trackNumber})`, {
        error: err.message,
        userId: this.userId,
      });
    });

    // Silence timer: catch up to wall clock time on each tick.
    // Instead of writing one frame per tick (which drifts with setInterval jitter),
    // we calculate how many frames SHOULD exist by now and write however many are missing.
    // Runs unconditionally — during speech, deficit is typically 0 (real packets keep up).
    // During silence, deficit grows and gets filled with silent frames.
    this.silenceTimer = setInterval(() => {
      if (this.failed) return;

      const totalElapsedMs = Date.now() - this.trackStartTime;
      const expectedFrames = Math.floor(totalElapsedMs / FRAME_DURATION_MS);
      const deficit = Math.max(0, expectedFrames - this.framesWritten);

      for (let i = 0; i < deficit; i++) {
        this.oggStream.write(SILENT_OPUS_FRAME);
      }
      this.framesWritten += deficit;
    }, FRAME_DURATION_MS);

    logger.debug(`Track ${this.trackNumber} started with silence padding`, {
      username: this.username,
    });
  }

  /** Reattach a new opus stream (e.g. after user rejoins the channel) */
  reattach(opusStream: Readable): void {
    if (this.failed) return;

    // Detach old stream if any
    if (this.opusStream) {
      this.opusStream.removeAllListeners();
      this.opusStream.destroy();
    }

    this.opusStream = opusStream;
    this.lastPacketTime = Date.now();

    opusStream.on('data', (packet: Buffer) => {
      if (this.failed) return;
      this.lastPacketTime = Date.now();
      this.framesWritten++;

      if (isValidOpusPacket(packet)) {
        this.validPackets++;
        this.oggStream.write(packet);
      } else {
        this.corruptPackets++;
        this.oggStream.write(SILENT_OPUS_FRAME);
      }
    });

    opusStream.on('error', (err) => {
      logger.warn(`Opus stream error for ${this.username} (track ${this.trackNumber}, reattached)`, {
        error: err.message,
        userId: this.userId,
      });
    });

    // Silence timer was still running — no gap in the file
    logger.info(`Track ${this.trackNumber} reattached: ${this.username}`, {
      userId: this.userId,
    });
  }

  /** Close this track due to a stream error. Other tracks keep recording. */
  private closeOnError(): void {
    if (this.failed) return;
    this.failed = true;

    logger.warn(`Track ${this.trackNumber} (${this.username}) closed due to error — other tracks continue`, {
      userId: this.userId,
    });

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.opusStream) {
      this.opusStream.removeAllListeners('data');
      this.opusStream.destroy();
      this.opusStream = null;
    }
    // Don't end oggStream/fileStream here — they already errored.
    // The partial file is still valid OGG up to the error point.
  }

  async stop(): Promise<void> {
    this.leftAt = new Date();

    // Stop silence timer
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    // Detach opus stream
    if (this.opusStream) {
      this.opusStream.removeAllListeners('data');
      this.opusStream.destroy();
      this.opusStream = null;
    }

    // If the track already failed, streams are already closed
    if (this.failed) {
      logger.info(`Track ${this.trackNumber} stopped (was failed): ${this.audioFile}`, {
        username: this.username,
      });
      return;
    }

    // End the OGG stream — this flushes remaining data to fileStream
    this.oggStream.end();

    // Wait for the file stream to finish writing
    if (!this.fileStream.writableFinished) {
      await once(this.fileStream, 'finish');
    }

    // Log file size
    let fileSize = '';
    try {
      const stats = statSync(this.filePath);
      const kb = (stats.size / 1024).toFixed(0);
      const mb = (stats.size / (1024 * 1024)).toFixed(1);
      fileSize = stats.size > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
    } catch {
      // File may not exist if track failed early
    }

    const corruptInfo = this.corruptPackets > 0
      ? `, ${this.corruptPackets} corrupt/${this.validPackets + this.corruptPackets} total packets`
      : '';

    logger.info(`Track ${this.trackNumber} stopped: ${this.audioFile}${fileSize ? ` (${fileSize})` : ''}${corruptInfo}`, {
      username: this.username,
      userId: this.userId,
      validPackets: this.validPackets,
      corruptPackets: this.corruptPackets,
    });
  }

  getMetadata(): TrackMetadata {
    return {
      track_number: this.trackNumber,
      discord_user_id: this.userId,
      discord_username: this.username,
      discord_display_name: this.displayName,
      joined_at: this.joinedAt.toISOString(),
      left_at: this.leftAt?.toISOString() ?? null,
      audio_file: this.audioFile,
    };
  }
}

export interface TrackMetadata {
  track_number: number;
  discord_user_id: string;
  discord_username: string;
  discord_display_name: string;
  joined_at: string;
  left_at: string | null;
  audio_file: string;
}
