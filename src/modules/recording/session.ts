import { mkdir } from 'node:fs/promises';
import { EndBehaviorType, type VoiceConnection } from '@discordjs/voice';
import { type Guild } from 'discord.js';
import { UserTrack, type TrackMetadata } from './track.js';
import { writeSessionMetadata } from './metadata.js';
import { logger } from '../../core/logger.js';

export interface SessionSummary {
  sessionId: string;
  outputDir: string;
  trackCount: number;
  tracks: TrackMetadata[];
  startTime: Date;
  endTime: Date;
}

export class RecordingSession {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly startTime: Date;
  readonly guildId: string;
  readonly guildName: string;
  readonly channelId: string;
  readonly channelName: string;

  private endTime: Date | null = null;
  private tracks = new Map<string, UserTrack>();
  private nextTrackNumber = 1;
  private connection: VoiceConnection | null = null;

  constructor(opts: {
    sessionId: string;
    recordingDir: string;
    guildId: string;
    guildName: string;
    channelId: string;
    channelName: string;
  }) {
    this.sessionId = opts.sessionId;
    this.outputDir = `${opts.recordingDir}/${opts.sessionId}`;
    this.startTime = new Date();
    this.guildId = opts.guildId;
    this.guildName = opts.guildName;
    this.channelId = opts.channelId;
    this.channelName = opts.channelName;
  }

  async init(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    logger.info(`Session ${this.sessionId} directory created`, {
      outputDir: this.outputDir,
    });
  }

  start(connection: VoiceConnection, guild: Guild): void {
    this.connection = connection;

    // Subscribe to speaking events
    connection.receiver.speaking.on('start', (userId) => {
      if (this.tracks.has(userId)) {
        // User already has a track — they may have left and rejoined.
        // The silence timer kept their file continuous while gone.
        // Nothing to do here; reattach is handled by voiceStateUpdate.
        return;
      }

      guild.members.fetch(userId).then((member) => {
        this.addUser(userId, member.user.username, member.displayName);
      }).catch((err) => {
        logger.warn(`Could not fetch member ${userId}`, {
          error: err instanceof Error ? err.message : String(err),
        });
        this.addUser(userId, userId, userId);
      });
    });

    logger.info(`Session ${this.sessionId} started`, {
      guild: this.guildName,
      channel: this.channelName,
    });
  }

  addUser(userId: string, username: string, displayName: string): void {
    if (this.tracks.has(userId) || !this.connection) return;

    const trackNumber = this.nextTrackNumber++;
    const track = new UserTrack({
      trackNumber,
      userId,
      username,
      displayName,
      outputDir: this.outputDir,
      recordingStartTime: this.startTime,
    });

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    track.start(opusStream);
    this.tracks.set(userId, track);

    logger.info(`Track ${trackNumber} recording: ${username}`, {
      userId,
      sessionId: this.sessionId,
    });
  }

  hasUser(userId: string): boolean {
    return this.tracks.has(userId);
  }

  /** Reattach a user who left and rejoined. Their silence timer kept the file continuous. */
  reattachUser(userId: string): void {
    const track = this.tracks.get(userId);
    if (!track || !this.connection) return;

    const opusStream = this.connection.receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.Manual },
    });

    track.reattach(opusStream);
  }

  async stop(): Promise<SessionSummary> {
    this.endTime = new Date();

    // Stop all tracks
    const stopPromises: Promise<void>[] = [];
    for (const track of this.tracks.values()) {
      stopPromises.push(track.stop());
    }
    await Promise.all(stopPromises);

    // Destroy voice connection
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }

    const trackMetadata = Array.from(this.tracks.values()).map((t) => t.getMetadata());

    // Write session_metadata.json
    await writeSessionMetadata(this, this.endTime, trackMetadata);

    logger.info(`Session ${this.sessionId} stopped`, {
      trackCount: this.tracks.size,
      duration: `${Math.round((this.endTime.getTime() - this.startTime.getTime()) / 1000)}s`,
    });

    return {
      sessionId: this.sessionId,
      outputDir: this.outputDir,
      trackCount: this.tracks.size,
      tracks: trackMetadata,
      startTime: this.startTime,
      endTime: this.endTime,
    };
  }
}
