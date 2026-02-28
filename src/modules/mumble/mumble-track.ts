/**
 * MumbleTrack — per-speaker OGG/Opus file writer for Mumble recordings.
 *
 * Adapted from src/modules/recording/track.ts with two key differences:
 *   1. channelCount: 1 (Mumble is mono; Discord is stereo)
 *   2. No DAVE/Opus corruption check needed — Mumble server decrypts
 *      OCB-AES128 before we see frames. Clean passthrough guaranteed.
 *
 * Silence padding strategy is identical to Discord:
 *   - Prepend silence for late joiners (align to recording start time)
 *   - Timer fills gaps with silent Opus frames during speech pauses
 *   - framesWritten counter tracks expected vs actual frames to avoid drift
 */

import { createWriteStream, statSync, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import prism from 'prism-media';
import { logger } from '../../core/logger.js';
import { SILENT_OPUS_FRAME, FRAME_DURATION_MS } from '../recording/silence.js';

export interface MumbleTrackMetadata {
  track_number: number;
  mumble_session_id: number;
  mumble_username: string;
  discord_user_id: string | null;
  discord_username: string | null;
  joined_at: string;
  left_at: string | null;
  audio_file: string;
}

export class MumbleTrack {
  readonly trackNumber: number;
  readonly sessionId: number;         // Mumble session ID (ephemeral per-connection)
  readonly username: string;          // Mumble username = QW display name
  readonly mumbleUserId: number;      // Murmur registered user ID (0 if anonymous)
  readonly filePath: string;
  readonly audioFile: string;
  readonly joinedAt: Date;
  leftAt: Date | null = null;

  // Discord link (optional — populated if user has linked their accounts)
  discordUserId: string | null = null;
  discordUsername: string | null = null;

  private oggStream: prism.opus.OggLogicalBitstream;
  private fileStream: WriteStream;
  private silenceTimer: ReturnType<typeof setInterval> | null = null;
  private framesWritten = 0;
  private trackStartTime = 0;
  private recordingStartTime: Date;
  private failed = false;

  constructor(opts: {
    trackNumber: number;
    sessionId: number;
    username: string;
    mumbleUserId: number;
    outputDir: string;
    recordingStartTime: Date;
    discordUserId?: string | null;
    discordUsername?: string | null;
  }) {
    this.trackNumber = opts.trackNumber;
    this.sessionId = opts.sessionId;
    this.username = opts.username;
    this.mumbleUserId = opts.mumbleUserId;
    this.joinedAt = new Date();
    this.recordingStartTime = opts.recordingStartTime;
    this.discordUserId = opts.discordUserId ?? null;
    this.discordUsername = opts.discordUsername ?? null;

    this.audioFile = `${opts.trackNumber}-${opts.username}.ogg`;
    this.filePath = `${opts.outputDir}/${this.audioFile}`;

    // Mono (channelCount=1) — Mumble sends mono Opus (Discord sends stereo)
    this.oggStream = new prism.opus.OggLogicalBitstream({
      opusHead: new prism.opus.OpusHead({
        channelCount: 1,
        sampleRate: 48000,
      }),
      pageSizeControl: { maxPackets: 10 },
      crc: true,
    });

    this.fileStream = createWriteStream(this.filePath);

    this.fileStream.on('error', (err) => {
      logger.error(`Mumble track ${this.trackNumber} file error (${this.username})`, {
        error: err.message,
        filePath: this.filePath,
      });
      this.closeOnError();
    });

    this.oggStream.on('error', (err) => {
      logger.error(`Mumble track ${this.trackNumber} OGG error (${this.username})`, {
        error: err.message,
      });
      this.closeOnError();
    });

    this.oggStream.pipe(this.fileStream);

    logger.debug(`Mumble track ${this.trackNumber} created: ${this.audioFile}`, {
      sessionId: this.sessionId,
      username: this.username,
    });
  }

  get isFailed(): boolean {
    return this.failed;
  }

  /** Begin recording. Pads silence for late joiners and starts the silence timer. */
  start(): void {
    if (this.failed) return;

    // Align to recording start: prepend silent frames if user joined late
    const gapMs = this.joinedAt.getTime() - this.recordingStartTime.getTime();
    if (gapMs > FRAME_DURATION_MS) {
      const silentFrames = Math.floor(gapMs / FRAME_DURATION_MS);
      for (let i = 0; i < silentFrames; i++) {
        this.oggStream.write(SILENT_OPUS_FRAME);
      }
      this.framesWritten += silentFrames;
      logger.debug(`Mumble track ${this.trackNumber} prepended ${silentFrames} silent frames (${gapMs}ms gap)`, {
        username: this.username,
      });
    }

    this.trackStartTime = this.recordingStartTime.getTime();

    // Silence filler: runs on every FRAME_DURATION_MS tick.
    // Calculates how many frames SHOULD exist by now vs how many were written,
    // then fills the deficit. This handles both VAD gaps and the case where
    // a user is not speaking. Real Opus frames written via writeOpusFrame()
    // keep framesWritten ahead of the deficit.
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

    logger.debug(`Mumble track ${this.trackNumber} started`, { username: this.username });
  }

  /** Write a real Opus frame from a Mumble voice packet. */
  writeOpusFrame(opusData: Buffer): void {
    if (this.failed) return;
    this.framesWritten++;
    this.oggStream.write(opusData);
  }

  private closeOnError(): void {
    if (this.failed) return;
    this.failed = true;

    logger.warn(`Mumble track ${this.trackNumber} (${this.username}) closed due to error`, {
      sessionId: this.sessionId,
    });

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  async stop(): Promise<void> {
    this.leftAt = new Date();

    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }

    if (this.failed) {
      logger.info(`Mumble track ${this.trackNumber} stopped (was failed): ${this.audioFile}`, {
        username: this.username,
      });
      return;
    }

    this.oggStream.end();

    if (!this.fileStream.writableFinished) {
      await once(this.fileStream, 'finish');
    }

    let fileSize = '';
    try {
      const stats = statSync(this.filePath);
      const mb = (stats.size / (1024 * 1024)).toFixed(1);
      const kb = (stats.size / 1024).toFixed(0);
      fileSize = stats.size > 1024 * 1024 ? `${mb} MB` : `${kb} KB`;
    } catch {
      // File may not exist if track failed early
    }

    logger.info(`Mumble track ${this.trackNumber} stopped: ${this.audioFile}${fileSize ? ` (${fileSize})` : ''}`, {
      username: this.username,
      sessionId: this.sessionId,
    });
  }

  getMetadata(): MumbleTrackMetadata {
    return {
      track_number: this.trackNumber,
      mumble_session_id: this.sessionId,
      mumble_username: this.username,
      discord_user_id: this.discordUserId,
      discord_username: this.discordUsername,
      joined_at: this.joinedAt.toISOString(),
      left_at: this.leftAt?.toISOString() ?? null,
      audio_file: this.audioFile,
    };
  }
}
