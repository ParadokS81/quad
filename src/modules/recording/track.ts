import { createWriteStream, type WriteStream } from 'node:fs';
import { type Readable } from 'node:stream';
import { once } from 'node:events';
import prism from 'prism-media';
import { logger } from '../../core/logger.js';
import { SILENT_OPUS_FRAME, FRAME_DURATION_MS } from './silence.js';

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
  private recordingStartTime: Date;

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
    });

    // Pipe OGG output to file
    this.oggStream.pipe(this.fileStream);

    logger.debug(`Track ${this.trackNumber} created: ${this.audioFile}`, {
      userId: this.userId,
      filePath: this.filePath,
    });
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
      logger.debug(`Track ${this.trackNumber} prepended ${silentFrames} silent frames (${gapMs}ms gap)`, {
        username: this.username,
      });
    }

    // Listen for real packets and write them to OGG
    this.lastPacketTime = Date.now();
    opusStream.on('data', (packet: Buffer) => {
      this.lastPacketTime = Date.now();
      this.oggStream.write(packet);
    });

    opusStream.on('error', (err) => {
      logger.warn(`Opus stream error for ${this.username} (track ${this.trackNumber})`, {
        error: err.message,
        userId: this.userId,
      });
    });

    // Silence timer: fill gaps when user isn't talking
    this.silenceTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastPacketTime;
      if (elapsed >= FRAME_DURATION_MS) {
        this.oggStream.write(SILENT_OPUS_FRAME);
      }
    }, FRAME_DURATION_MS);

    logger.debug(`Track ${this.trackNumber} started with silence padding`, {
      username: this.username,
    });
  }

  /** Reattach a new opus stream (e.g. after user rejoins the channel) */
  reattach(opusStream: Readable): void {
    // Detach old stream if any
    if (this.opusStream) {
      this.opusStream.removeAllListeners('data');
      this.opusStream.destroy();
    }

    this.opusStream = opusStream;
    this.lastPacketTime = Date.now();

    opusStream.on('data', (packet: Buffer) => {
      this.lastPacketTime = Date.now();
      this.oggStream.write(packet);
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

    // End the OGG stream — this flushes remaining data to fileStream
    this.oggStream.end();

    // Wait for the file stream to finish writing
    if (!this.fileStream.writableFinished) {
      await once(this.fileStream, 'finish');
    }

    logger.info(`Track ${this.trackNumber} stopped: ${this.audioFile}`, {
      username: this.username,
      userId: this.userId,
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
