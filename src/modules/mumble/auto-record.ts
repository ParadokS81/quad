/**
 * AutoRecord — monitors Mumble team channels and starts/stops recordings
 * based on user presence.
 *
 * Design:
 *   - Watches mumbleConfig docs for channel→team mapping
 *   - Watches botRegistrations for autoRecord settings (enabled, minPlayers, platform)
 *   - Listens to the MumbleClient's userCreate/userUpdate/userRemove events
 *   - When enough users join a team channel → start recording
 *   - When a team channel becomes empty → 5-second grace period → stop recording
 *   - Registers sessions in the shared session registry
 *   - Respects suppression after manual /record stop
 *
 * Only records in team channels (those in mumbleConfig). Ignores Root and Teams parent.
 * The bot's own session ID is excluded from user counts.
 *
 * Settings priority:
 *   1. botRegistrations/{teamId}.autoRecord (primary — unified settings)
 *   2. mumbleConfig/{teamId}.autoRecord boolean (legacy fallback during transition)
 */

import { randomUUID } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { Client as MumbleClient, User } from '@tf2pickup-org/mumble-client';
import { MumbleRecordingSession, type MumbleSessionSummary } from './mumble-session.js';
import { sessionRegistry, type SessionOrigin } from '../../shared/session-registry.js';
import { logger } from '../../core/logger.js';

const GRACE_PERIOD_MS = 5_000; // 5 seconds after last user leaves

/** Config entry for one active team channel, from mumbleConfig Firestore doc. */
interface TeamChannelConfig {
  teamId: string;
  teamTag: string;
  teamName: string;
  channelId: number;
  channelName: string;
  /** Legacy mumbleConfig.autoRecord — used for backward compat only. */
  legacyAutoRecord?: boolean;
}

/** Cached autoRecord settings from botRegistrations. */
interface BotRegistrationConfig {
  guildId: string;
  autoRecord?: {
    enabled: boolean;
    minPlayers: number;
    platform: 'both' | 'discord' | 'mumble';
    mode?: string;
  };
}

export class AutoRecord {
  private db: Firestore | null = null;
  private mumbleClient: MumbleClient | null = null;
  private recordingDir = '';
  private botSessionId: number | null = null;

  /** Active team channels read from Firestore mumbleConfig */
  private teamChannels = new Map<number, TeamChannelConfig>();  // channelId → config

  /** Cached autoRecord settings from Firestore botRegistrations */
  private botRegistrationConfigs = new Map<string, BotRegistrationConfig>();  // teamId → config

  /** Active recording sessions, keyed by channelId */
  private sessions = new Map<number, MumbleRecordingSession>();

  /** Grace period timers per channelId */
  private idleTimers = new Map<number, ReturnType<typeof setTimeout>>();

  /** Channels suppressed after manual /record stop — auto-record blocked until channel empties */
  private suppressedChannels = new Set<number>();

  /** Callback fired after a recording session stops (for pipeline trigger) */
  onRecordingStop: ((summary: MumbleSessionSummary) => Promise<void>) | null = null;

  private unsubscribeConfigs: (() => void) | null = null;
  private unsubscribeBotRegs: (() => void) | null = null;

  start(
    db: Firestore,
    mumbleClient: MumbleClient,
    recordingDir: string,
  ): void {
    this.db = db;
    this.mumbleClient = mumbleClient;
    this.recordingDir = recordingDir;
    this.botSessionId = mumbleClient.isConnected() ? mumbleClient.session : null;

    // Watch active mumble configs for channel→team mapping
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
                legacyAutoRecord: data.autoRecord as boolean | undefined,
              });
            }
          }
          logger.debug(`AutoRecord: ${this.teamChannels.size} team channel(s) monitored`);
        },
        (err) => logger.error('AutoRecord: mumbleConfig snapshot error', { error: String(err) }),
      );

    // Watch active bot registrations for unified autoRecord settings
    this.unsubscribeBotRegs = db.collection('botRegistrations')
      .where('status', '==', 'active')
      .onSnapshot(
        (snapshot) => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'removed') {
              this.botRegistrationConfigs.delete(change.doc.id);
            } else {
              const data = change.doc.data();
              this.botRegistrationConfigs.set(change.doc.id, {
                guildId: data.guildId ?? '',
                autoRecord: data.autoRecord ?? undefined,
              });
            }
          }
          logger.debug(`AutoRecord: ${this.botRegistrationConfigs.size} bot registration(s) cached`);
        },
        (err) => logger.error('AutoRecord: botRegistrations snapshot error', { error: String(err) }),
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
    this.unsubscribeBotRegs?.();
    this.unsubscribeBotRegs = null;

    // Cancel grace timers
    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer);
    }
    this.idleTimers.clear();

    // Stop all active recordings (fire and forget on shutdown)
    for (const [channelId, session] of this.sessions) {
      session.stop().then((summary) => {
        sessionRegistry.unregister(`mumble:${channelId}`);
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
    this.suppressedChannels.clear();

    this.mumbleClient = null;
    this.db = null;
    logger.info('AutoRecord stopped');
  }

  // ---------------------------------------------------------------------------
  // Public API for cross-module access (Task 5)
  // ---------------------------------------------------------------------------

  /**
   * Start recording in the team's Mumble channel.
   * Ignores suppression (explicit manual start always wins).
   * Adds all users currently in the channel.
   */
  async startForTeam(teamId: string): Promise<MumbleRecordingSession | null> {
    const config = this.findChannelConfig(teamId);
    if (!config) {
      logger.warn('AutoRecord.startForTeam: no channel config for team', { teamId });
      return null;
    }

    // Manual start clears suppression
    this.suppressedChannels.delete(config.channelId);
    this.cancelIdleTimer(config.channelId);

    const session = await this.ensureRecording(config, 'manual');
    for (const user of this.getAllUsersInChannel(config.channelId)) {
      session.addUser(user.session, user.name ?? String(user.session), user.userId ?? 0);
    }
    return session;
  }

  /**
   * Stop recording in the team's Mumble channel.
   * Sets suppression so auto-record won't restart while users are still present.
   * Suppression clears when the channel fully empties (via grace timer).
   */
  async stopForTeam(teamId: string): Promise<void> {
    const config = this.findChannelConfig(teamId);
    if (!config) return;

    const channelId = config.channelId;

    // Cancel any pending grace timer (we're explicitly stopping now)
    this.cancelIdleTimer(channelId);

    // Stop the recording session directly
    const session = this.sessions.get(channelId);
    if (session) {
      this.sessions.delete(channelId);
      sessionRegistry.unregister(`mumble:${channelId}`);
      try {
        const summary = await session.stop();
        if (this.onRecordingStop) {
          await this.onRecordingStop(summary);
        }
      } catch (err) {
        logger.error('AutoRecord: error stopping recording (manual)', {
          channelId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Suppress auto-record — clears when channel empties via grace timer → stopRecording
    this.suppressedChannels.add(channelId);

    // If the channel is already empty, start grace timer now to clear suppression
    if (this.getUsersInChannel(channelId) === 0 && !this.idleTimers.has(channelId)) {
      this.startIdleTimer(channelId, config);
    }
  }

  /** Return usernames of users currently in the team's Mumble channel. */
  getUsernamesInChannel(teamId: string): string[] {
    const config = this.findChannelConfig(teamId);
    if (!config) return [];
    return this.getAllUsersInChannel(config.channelId)
      .map(u => u.name ?? String(u.session));
  }

  // ---------------------------------------------------------------------------
  // Decision helpers
  // ---------------------------------------------------------------------------

  /**
   * Determine whether auto-record is enabled for a team channel.
   * Primary source: botRegistrations.autoRecord (enabled + platform).
   * Fallback: mumbleConfig.autoRecord boolean (backward compat during transition).
   */
  private isAutoRecordEnabled(config: TeamChannelConfig): boolean {
    const botReg = this.botRegistrationConfigs.get(config.teamId);

    if (botReg?.autoRecord !== undefined) {
      // Primary source: botRegistrations
      if (!botReg.autoRecord.enabled) return false;
      const platform = botReg.autoRecord.platform ?? 'both';
      return platform === 'both' || platform === 'mumble';
    }

    // Backward compat: fall back to mumbleConfig.autoRecord
    // Old behavior: undefined/true = record, false = skip
    return config.legacyAutoRecord !== false;
  }

  /** Get the minPlayers threshold for a team (default: 3). */
  private getMinPlayers(teamId: string): number {
    return this.botRegistrationConfigs.get(teamId)?.autoRecord?.minPlayers ?? 3;
  }

  // ---------------------------------------------------------------------------
  // User event handlers
  // ---------------------------------------------------------------------------

  private onUserCreate(user: User): void {
    if (this.isBotUser(user)) return;

    const config = this.teamChannels.get(user.channelId);
    if (!config) return;

    logger.info(`AutoRecord: user joined team channel — ${user.name} → #${config.channelName}`, {
      mumbleSessionId: user.session,
      channelId: user.channelId,
    });

    this.handleUserJoin(user, config);
  }

  private onUserUpdate(user: User): void {
    if (this.isBotUser(user)) return;

    // User moved channels — new channelId already set on user object.
    const newConfig = this.teamChannels.get(user.channelId);
    if (newConfig) {
      // User moved INTO a team channel
      this.handleUserJoin(user, newConfig);
    }

    // Check if any other team channel became empty (user may have left it)
    for (const [channelId, config] of this.teamChannels) {
      if (channelId === user.channelId) continue;  // Just moved to this one

      const hasSession = this.sessions.has(channelId);
      const hasSuppression = this.suppressedChannels.has(channelId);
      if (!hasSession && !hasSuppression) continue;

      const channelUsers = this.getUsersInChannel(channelId);
      if (channelUsers === 0 && !this.idleTimers.has(channelId)) {
        logger.info(`AutoRecord: team channel #${config.channelName} now empty — grace period started`);
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
    const hasSuppression = this.suppressedChannels.has(config.channelId);

    if (remaining === 0 && (session || hasSuppression) && !this.idleTimers.has(config.channelId)) {
      logger.info(`AutoRecord: team channel #${config.channelName} empty — grace period started`);
      this.startIdleTimer(config.channelId, config);
    }
  }

  /**
   * Shared logic for user joining a team channel (from userCreate or userUpdate).
   * If recording is running: add user and cancel any grace timer.
   * If not running: check suppression, then minPlayers threshold.
   */
  private handleUserJoin(user: User, config: TeamChannelConfig): void {
    if (!this.isAutoRecordEnabled(config)) {
      logger.debug(`AutoRecord: auto-record disabled for team ${config.teamTag}`);
      return;
    }

    // If recording already running, extend it — cancel grace timer and add user
    const existing = this.sessions.get(config.channelId);
    if (existing) {
      this.cancelIdleTimer(config.channelId);
      existing.addUser(user.session, user.name ?? String(user.session), user.userId ?? 0);
      return;
    }

    // No active session — check suppression before starting
    if (this.suppressedChannels.has(config.channelId)) {
      // Do NOT cancel the grace timer. Let it run — when it fires it clears suppression
      // and re-checks whether to start a new recording. If we cancelled the timer here,
      // suppression would be stuck until the channel empties again for a full 5 seconds.
      logger.debug(`AutoRecord: suppressed for #${config.channelName} — not starting`);
      return;
    }

    // Check minPlayers threshold (count includes the user who just joined)
    const usersInChannel = this.getUsersInChannel(config.channelId);
    const minPlayers = this.getMinPlayers(config.teamId);
    if (usersInChannel < minPlayers) {
      logger.debug(`AutoRecord: ${usersInChannel}/${minPlayers} in #${config.channelName} — waiting for threshold`);
      return;
    }

    // Threshold met — start recording and add ALL current users in channel
    this.cancelIdleTimer(config.channelId);
    this.ensureRecording(config).then((session) => {
      for (const channelUser of this.getAllUsersInChannel(config.channelId)) {
        session.addUser(channelUser.session, channelUser.name ?? String(channelUser.session), channelUser.userId ?? 0);
      }
      logger.info(`AutoRecord: threshold met (${usersInChannel}/${minPlayers}) — recording started`, {
        channel: config.channelName,
        team: config.teamTag,
      });
    }).catch(err => {
      logger.error('AutoRecord: failed to start recording', { error: String(err) });
    });
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  private async ensureRecording(config: TeamChannelConfig, origin: SessionOrigin = 'auto'): Promise<MumbleRecordingSession> {
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

    // Register in shared session registry
    const botReg = this.botRegistrationConfigs.get(config.teamId);
    sessionRegistry.register(`mumble:${config.channelId}`, {
      platform: 'mumble',
      origin,
      sessionId,
      channelId: String(config.channelId),
      guildId: botReg?.guildId ?? '',
      teamId: config.teamId,
      startTime: new Date(),
    });

    logger.info(`AutoRecord: recording started for team ${config.teamTag} in #${config.channelName}`, {
      sessionId,
      channelId: config.channelId,
    });

    return session;
  }

  /**
   * Stop a recording session and clean up registry + suppression.
   * Called by the grace period timer when a channel has been empty for GRACE_PERIOD_MS.
   * The session may already be stopped (e.g., via stopForTeam) — that's fine.
   */
  private async stopRecording(channelId: number): Promise<void> {
    const key = `mumble:${channelId}`;
    const session = this.sessions.get(channelId);

    // Clean up registry and suppression (channel is empty = suppression over)
    sessionRegistry.unregister(key);
    sessionRegistry.clearSuppression(key);  // No-op in current impl, semantic intent
    this.suppressedChannels.delete(channelId);

    if (!session) return;  // Already stopped (e.g., by stopForTeam)

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
      logger.info(`AutoRecord: grace period ended — stopping recording for #${config.channelName}`, { channelId });
      await this.stopRecording(channelId);  // Stops session (if any) + clears suppression

      // After clearing suppression, check if users rejoined during the grace period.
      // This handles the case where a user rejoined while suppressed (we intentionally
      // did not cancel the timer) — now that suppression is cleared, start recording
      // if the threshold is met.
      if (this.isAutoRecordEnabled(config) && !this.suppressedChannels.has(channelId)) {
        const usersInChannel = this.getUsersInChannel(channelId);
        const minPlayers = this.getMinPlayers(config.teamId);
        if (usersInChannel >= minPlayers) {
          logger.info(`AutoRecord: users present after grace — starting recording for #${config.channelName}`, {
            usersInChannel,
            minPlayers,
          });
          this.ensureRecording(config).then((session) => {
            for (const user of this.getAllUsersInChannel(channelId)) {
              session.addUser(user.session, user.name ?? String(user.session), user.userId ?? 0);
            }
          }).catch(err => {
            logger.error('AutoRecord: failed to start recording after grace', { error: String(err) });
          });
        }
      }
    }, GRACE_PERIOD_MS);

    this.idleTimers.set(channelId, timer);
  }

  private cancelIdleTimer(channelId: number): void {
    const timer = this.idleTimers.get(channelId);
    if (!timer) return;

    clearTimeout(timer);
    this.idleTimers.delete(channelId);
    logger.debug('AutoRecord: grace timer cancelled', { channelId });
  }

  // ---------------------------------------------------------------------------
  // Mumble client helpers
  // ---------------------------------------------------------------------------

  private findChannelConfig(teamId: string): TeamChannelConfig | undefined {
    for (const config of this.teamChannels.values()) {
      if (config.teamId === teamId) return config;
    }
    return undefined;
  }

  /** Get all non-bot User objects in a Mumble channel. */
  private getAllUsersInChannel(channelId: number): User[] {
    if (!this.mumbleClient?.isConnected()) return [];
    return this.mumbleClient.users
      .findAll((u) => u.channelId === channelId && !this.isBotUser(u));
  }

  /** Count non-bot users currently in a Mumble channel. */
  private getUsersInChannel(channelId: number): number {
    return this.getAllUsersInChannel(channelId).length;
  }

  private isBotUser(user: User): boolean {
    if (!this.mumbleClient?.isConnected()) return false;
    return user.session === this.mumbleClient.session;
  }
}
