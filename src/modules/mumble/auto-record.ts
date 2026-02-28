/**
 * AutoRecord — monitors Mumble team channels and starts/stops recordings
 * based on user presence.
 *
 * Design:
 *   - Watches all active mumbleConfig docs to know which channelIds are team channels
 *   - Listens to the MumbleClient's userCreate/userUpdate/userRemove events
 *   - When a non-bot user appears in a team channel → start recording (if not already)
 *   - When a team channel becomes empty → start idle timer → stop after 30 min
 *   - Recording sessions are keyed by channelId
 *
 * Only records in team channels (those in mumbleConfig). Ignores Root and Teams parent.
 *
 * The bot's own session ID is excluded from user counts. The library emits userCreate
 * for the bot itself (client.session) — we filter that out.
 */

import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Client as MumbleClient, User } from '@tf2pickup-org/mumble-client';
import { MumbleRecordingSession, type MumbleSessionSummary } from './mumble-session.js';
import { logger } from '../../core/logger.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/** Config entry for one active team channel, from mumbleConfig Firestore doc. */
interface TeamChannelConfig {
  teamId: string;
  teamTag: string;
  teamName: string;
  channelId: number;
  channelName: string;
  /** Per-team auto-record toggle from Firestore. Undefined = not set (default: record). */
  autoRecord?: boolean;
}

export class AutoRecord {
  private db: Firestore | null = null;
  private mumbleClient: MumbleClient | null = null;
  private recordingDir = '';
  private botSessionId: number | null = null;

  /** Active team channels read from Firestore mumbleConfig */
  private teamChannels = new Map<number, TeamChannelConfig>();  // channelId → config

  /** Active recording sessions, keyed by channelId */
  private sessions = new Map<number, MumbleRecordingSession>();

  /** Idle timers per channelId */
  private idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Callback fired after a recording session stops (for pipeline trigger) */
  onRecordingStop: ((summary: MumbleSessionSummary) => Promise<void>) | null = null;

  private unsubscribeConfigs: (() => void) | null = null;

  start(
    db: Firestore,
    mumbleClient: MumbleClient,
    recordingDir: string,
  ): void {
    this.db = db;
    this.mumbleClient = mumbleClient;
    this.recordingDir = recordingDir;
    this.botSessionId = mumbleClient.isConnected() ? mumbleClient.session : null;

    // Watch active mumble configs to know which channels are team channels
    this.unsubscribeConfigs = db.collection('mumbleConfig')
      .where('status', '==', 'active')
      .onSnapshot(
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            const data = change.doc.data();
            const channelId = data.channelId as number | undefined;
            if (!channelId) continue;

            if (change.type === 'removed') {
              this.teamChannels.delete(channelId);
            } else {
              this.teamChannels.set(channelId, {
                teamId: change.doc.id,
                teamTag: data.teamTag ?? '',
                teamName: data.teamName ?? '',
                channelId,
                channelName: data.channelName ?? String(channelId),
                autoRecord: data.autoRecord as boolean | undefined,
              });
            }
          }

          logger.debug(`AutoRecord: ${this.teamChannels.size} team channel(s) monitored`);
        },
        (err) => logger.error('AutoRecord: mumbleConfig snapshot error', { error: String(err) }),
      );

    // Listen to user state changes from the control plane client
    mumbleClient.on('userCreate', (user: User) => this.onUserCreate(user));
    mumbleClient.on('userUpdate', (user: User) => this.onUserUpdate(user));
    mumbleClient.on('userRemove', (user: User) => this.onUserRemove(user));

    logger.info('AutoRecord started');
  }

  stop(): void {
    this.unsubscribeConfigs?.();
    this.unsubscribeConfigs = null;

    // Cancel idle timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Stop all active recordings (fire and forget on shutdown)
    for (const [channelId, session] of this.sessions) {
      session.stop().then((summary) => {
        if (this.onRecordingStop) {
          this.onRecordingStop(summary).catch(err => {
            logger.error('AutoRecord: onRecordingStop callback failed', { error: String(err) });
          });
        }
      }).catch(err => {
        logger.error('AutoRecord: error stopping session on shutdown', {
          channelId,
          error: String(err),
        });
      });
    }
    this.sessions.clear();

    this.mumbleClient = null;
    this.db = null;
    logger.info('AutoRecord stopped');
  }

  private onUserCreate(user: User): void {
    if (this.isBotUser(user)) return;

    const config = this.teamChannels.get(user.channelId);
    if (!config) return;

    logger.info(`AutoRecord: user joined team channel — ${user.name} → #${config.channelName}`, {
      mumbleSessionId: user.session,
      channelId: user.channelId,
    });

    if (config.autoRecord === false) {
      logger.debug(`AutoRecord: auto-record disabled for team ${config.teamTag} — not recording`);
      return;
    }

    this.cancelIdleTimer(config.channelId);
    this.ensureRecording(config).then((session) => {
      session.addUser(user.session, user.name ?? String(user.session), user.userId ?? 0);
    }).catch(err => {
      logger.error('AutoRecord: failed to start/extend recording', { error: String(err) });
    });
  }

  private onUserUpdate(user: User): void {
    if (this.isBotUser(user)) return;

    // User moved channels — handle as leave from old channel + join in new channel.
    // The library gives us the updated user state (new channelId already set).
    // We can't know the old channelId here, but the idle timer logic handles cleanup.

    const newConfig = this.teamChannels.get(user.channelId);
    if (newConfig) {
      // User moved INTO a team channel
      if (newConfig.autoRecord === false) {
        logger.debug(`AutoRecord: auto-record disabled for team ${newConfig.teamTag} — not recording`);
      } else {
        this.cancelIdleTimer(newConfig.channelId);
        this.ensureRecording(newConfig).then((session) => {
          session.addUser(user.session, user.name ?? String(user.session), user.userId ?? 0);
        }).catch(err => {
          logger.error('AutoRecord: failed to extend recording on channel join', { error: String(err) });
        });
      }
    }

    // Check if any team channel is now empty (user may have left it)
    for (const [channelId, config] of this.teamChannels) {
      if (channelId === user.channelId) continue;  // Just moved to this one

      const session = this.sessions.get(channelId);
      if (!session) continue;

      const channelUsers = this.getUsersInChannel(channelId);
      if (channelUsers === 0 && !this.idleTimers.has(channelId)) {
        logger.info(`AutoRecord: team channel #${config.channelName} now empty — idle timer started`);
        this.startIdleTimer(channelId, config);
      }
    }
  }

  private onUserRemove(user: User): void {
    if (this.isBotUser(user)) return;

    const config = this.teamChannels.get(user.channelId);
    if (!config) return;

    logger.info(`AutoRecord: user left team channel — ${user.name ?? user.session} → #${config.channelName}`, {
      mumbleSessionId: user.session,
    });

    const session = this.sessions.get(config.channelId);
    if (session) {
      session.removeUser(user.session);
    }

    // Check if channel is now empty
    const remaining = this.getUsersInChannel(config.channelId);
    if (remaining === 0) {
      logger.info(`AutoRecord: team channel #${config.channelName} empty — idle timer started`);
      this.startIdleTimer(config.channelId, config);
    }
  }

  private async ensureRecording(config: TeamChannelConfig): Promise<MumbleRecordingSession> {
    const existing = this.sessions.get(config.channelId);
    if (existing) return existing;

    const sessionId = randomUUID();
    const session = new MumbleRecordingSession({
      sessionId,
      recordingDir: this.recordingDir,
      channelId: config.channelId,
      channelName: config.channelName,
      teamId: config.teamId,
      teamTag: config.teamTag,
      teamName: config.teamName,
    });

    await session.init();
    session.start(this.mumbleClient!);
    this.sessions.set(config.channelId, session);

    logger.info(`AutoRecord: recording started for team ${config.teamTag} in #${config.channelName}`, {
      sessionId,
      channelId: config.channelId,
    });

    return session;
  }

  private async stopRecording(channelId: number): Promise<void> {
    const session = this.sessions.get(channelId);
    if (!session) return;

    this.sessions.delete(channelId);

    try {
      const summary = await session.stop();
      if (this.onRecordingStop) {
        await this.onRecordingStop(summary);
      }
    } catch (err) {
      logger.error('AutoRecord: error stopping recording', {
        channelId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private startIdleTimer(channelId: number, config: TeamChannelConfig): void {
    if (this.idleTimers.has(channelId)) return;

    const timer = setTimeout(async () => {
      this.idleTimers.delete(channelId);
      if (!this.sessions.has(channelId)) return;

      logger.info(`AutoRecord: idle timeout — stopping recording for #${config.channelName}`, {
        channelId,
      });
      await this.stopRecording(channelId);
    }, IDLE_TIMEOUT_MS);

    this.idleTimers.set(channelId, timer);
  }

  private cancelIdleTimer(channelId: number): void {
    const timer = this.idleTimers.get(channelId);
    if (!timer) return;

    clearTimeout(timer);
    this.idleTimers.delete(channelId);
    logger.debug('AutoRecord: idle timer cancelled', { channelId });
  }

  /** Count non-bot users currently in a Mumble channel. */
  private getUsersInChannel(channelId: number): number {
    if (!this.mumbleClient?.isConnected()) return 0;
    return this.mumbleClient.users
      .findAll((u) => u.channelId === channelId && !this.isBotUser(u))
      .length;
  }

  private isBotUser(user: User): boolean {
    if (!this.mumbleClient?.isConnected()) return false;
    return user.session === this.mumbleClient.session;
  }
}
