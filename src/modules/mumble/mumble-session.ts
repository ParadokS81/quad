/**
 * MumbleRecordingSession — manages one per-channel recording session.
 *
 * Lifecycle:
 *   1. new MumbleRecordingSession(opts) — construct with channel + team info
 *   2. await session.init()             — create output directory
 *   3. session.start()                  — begin receiving voice (attach voice receiver)
 *   4. session.addUser(...)             — create a track for a new speaker
 *   5. session.removeUser(sessionId)    — user left (track keeps running for silence pad)
 *   6. await session.stop()             — stop all tracks, write metadata, return summary
 *
 * Per-speaker OGG files are written to recordings/{sessionId}/.
 * session_metadata.json is written on stop().
 */

import { mkdir, stat } from 'node:fs/promises';
import { type Client as MumbleClient } from '@tf2pickup-org/mumble-client';
import { MumbleTrack, type MumbleTrackMetadata } from './mumble-track.js';
import { writeMumbleSessionMetadata } from './mumble-metadata.js';
import { VoiceReceiver } from './voice-receiver.js';
import { logger } from '../../core/logger.js';

export interface MumbleSessionSummary {
  sessionId: string;
  outputDir: string;
  channelId: number;
  channelName: string;
  teamId: string;
  teamTag: string;
  teamName: string;
  trackCount: number;
  tracks: MumbleTrackMetadata[];
  startTime: Date;
  endTime: Date;
}

export class MumbleRecordingSession {
  readonly sessionId: string;
  readonly outputDir: string;
  readonly startTime: Date;
  readonly channelId: number;
  readonly channelName: string;
  readonly teamId: string;
  readonly teamTag: string;
  readonly teamName: string;

  private tracks = new Map<number, MumbleTrack>();  // keyed by Mumble session ID
  private nextTrackNumber = 1;
  private voiceReceiver: VoiceReceiver | null = null;
  private stopping = false;

  constructor(opts: {
    sessionId: string;
    recordingDir: string;
    channelId: number;
    channelName: string;
    teamId: string;
    teamTag: string;
    teamName: string;
  }) {
    this.sessionId = opts.sessionId;
    this.outputDir = `${opts.recordingDir}/${opts.sessionId}`;
    this.startTime = new Date();
    this.channelId = opts.channelId;
    this.channelName = opts.channelName;
    this.teamId = opts.teamId;
    this.teamTag = opts.teamTag;
    this.teamName = opts.teamName;
  }

  async init(): Promise<void> {
    await mkdir(this.outputDir, { recursive: true });
    logger.info(`Mumble session ${this.sessionId} directory created`, {
      outputDir: this.outputDir,
      channel: this.channelName,
      team: this.teamTag,
    });
  }

  /**
   * Start receiving voice. Attaches the VoiceReceiver to the MumbleClient socket.
   * Voice packets from all users are routed here; only those in our channel
   * (tracked by addUser/removeUser) get written to tracks.
   */
  start(mumbleClient: MumbleClient): void {
    this.voiceReceiver = new VoiceReceiver();
    this.voiceReceiver.attach(mumbleClient, (packet) => {
      if (this.stopping) return;
      const track = this.tracks.get(packet.senderSession);
      if (track && !track.isFailed) {
        track.writeOpusFrame(packet.opusData);
      }
    });

    logger.info(`Mumble session ${this.sessionId} started`, {
      channel: this.channelName,
      team: this.teamTag,
    });
  }

  /**
   * Add a user who joined the channel (create their track).
   * Idempotent: if the user already has a track, returns it without creating a new one.
   */
  addUser(
    mumbleSessionId: number,
    username: string,
    mumbleUserId: number,
    discordUserId?: string | null,
    discordUsername?: string | null,
  ): MumbleTrack {
    const existing = this.tracks.get(mumbleSessionId);
    if (existing) return existing;

    const trackNumber = this.nextTrackNumber++;
    const track = new MumbleTrack({
      trackNumber,
      sessionId: mumbleSessionId,
      username,
      mumbleUserId,
      outputDir: this.outputDir,
      recordingStartTime: this.startTime,
      discordUserId,
      discordUsername,
    });

    track.start();
    this.tracks.set(mumbleSessionId, track);

    logger.info(`Mumble track ${trackNumber} recording: ${username}`, {
      mumbleSessionId,
      mumbleUserId,
      sessionId: this.sessionId,
    });

    return track;
  }

  /**
   * Called when a user leaves the channel. The track keeps running (silence padding)
   * until stop() is called on the session.
   */
  removeUser(mumbleSessionId: number): void {
    const track = this.tracks.get(mumbleSessionId);
    if (track) {
      logger.info(`User left Mumble channel: ${track.username}`, {
        mumbleSessionId,
        sessionId: this.sessionId,
      });
    }
    // We intentionally keep the track in the map — silence timer continues
  }

  hasUser(mumbleSessionId: number): boolean {
    return this.tracks.has(mumbleSessionId);
  }

  getUserCount(): number {
    return this.tracks.size;
  }

  async stop(): Promise<MumbleSessionSummary> {
    this.stopping = true;
    const endTime = new Date();

    // Detach voice receiver first so no more packets are written
    if (this.voiceReceiver) {
      this.voiceReceiver.detach();
      this.voiceReceiver = null;
    }

    // Stop all tracks
    await Promise.all(Array.from(this.tracks.values()).map((t) => t.stop()));

    const trackMetadata = Array.from(this.tracks.values()).map((t) => t.getMetadata());

    // Write session_metadata.json
    await writeMumbleSessionMetadata({
      session: this,
      endTime,
      tracks: trackMetadata,
    });

    // Total file size for logging
    let totalBytes = 0;
    for (const track of this.tracks.values()) {
      try {
        const s = await stat(track.filePath);
        totalBytes += s.size;
      } catch {
        // Track may have failed
      }
    }
    const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);

    logger.info(`Mumble session ${this.sessionId} stopped`, {
      trackCount: this.tracks.size,
      duration: `${Math.round((endTime.getTime() - this.startTime.getTime()) / 1000)}s`,
      totalSize: `${totalMB} MB`,
    });

    return {
      sessionId: this.sessionId,
      outputDir: this.outputDir,
      channelId: this.channelId,
      channelName: this.channelName,
      teamId: this.teamId,
      teamTag: this.teamTag,
      teamName: this.teamName,
      trackCount: this.tracks.size,
      tracks: trackMetadata,
      startTime: this.startTime,
      endTime,
    };
  }
}
