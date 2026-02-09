import { createWriteStream, type WriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { type Readable } from 'node:stream';
import prism from 'prism-media';
import { logger } from '../../core/logger.js';

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
  private pipelinePromise: Promise<void> | null = null;

  constructor(opts: {
    trackNumber: number;
    userId: string;
    username: string;
    displayName: string;
    outputDir: string;
  }) {
    this.trackNumber = opts.trackNumber;
    this.userId = opts.userId;
    this.username = opts.username;
    this.displayName = opts.displayName;
    this.joinedAt = new Date();

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

    logger.debug(`Track ${this.trackNumber} created: ${this.audioFile}`, {
      userId: this.userId,
      filePath: this.filePath,
    });
  }

  start(opusStream: Readable): void {
    this.opusStream = opusStream;

    this.pipelinePromise = pipeline(opusStream, this.oggStream, this.fileStream)
      .then(() => {
        logger.debug(`Track ${this.trackNumber} pipeline finished cleanly`, {
          username: this.username,
        });
      })
      .catch((err) => {
        // ERR_STREAM_PREMATURE_CLOSE is expected when we destroy the opus stream on stop
        if (err?.code === 'ERR_STREAM_PREMATURE_CLOSE') {
          logger.debug(`Track ${this.trackNumber} pipeline closed (expected on stop)`, {
            username: this.username,
          });
          return;
        }
        logger.warn(`Track ${this.trackNumber} pipeline error`, {
          username: this.username,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  async stop(): Promise<void> {
    this.leftAt = new Date();

    // Destroy the opus stream to trigger pipeline close
    if (this.opusStream) {
      this.opusStream.destroy();
      this.opusStream = null;
    }

    // Wait for the pipeline to finish flushing
    if (this.pipelinePromise) {
      await this.pipelinePromise;
      this.pipelinePromise = null;
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
