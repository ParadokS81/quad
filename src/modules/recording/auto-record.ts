/**
 * Discord auto-record engine — monitors voiceStateUpdate events and
 * auto-starts recording when enough registered team members join a
 * voice channel. Stops after a 5-second grace period when they all leave.
 *
 * Settings come from botRegistrations Firestore docs (autoRecord field).
 * Multi-team guilds are skipped entirely for safety.
 */

import { ChannelType, type Client, type Guild, type VoiceBasedChannel, type VoiceState } from 'discord.js';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { sessionRegistry } from '../../shared/session-registry.js';
import {
  startRecordingSession,
  performStop,
  stopRecording,
  isRecording,
  getRecordingChannelId,
  checkVoicePermissions,
} from './commands/record.js';

const GRACE_PERIOD_MS = 5_000;       // 5 seconds after last registered member leaves
const KICK_COOLDOWN_MS = 60_000;     // 60 seconds after connection loss before retrying

interface AutoRecordSettings {
  enabled: boolean;
  minPlayers: number;
  platform: 'both' | 'discord' | 'mumble';
}

interface TeamAutoConfig {
  teamId: string;
  guildId: string;
  knownPlayers: Record<string, string>;  // discordUserId → QW name
  autoRecord: AutoRecordSettings;
}

export class DiscordAutoRecord {
  private client: Client | null = null;

  /** guildId → configs (multiple entries = multi-team guild → skip) */
  private guildConfigs = new Map<string, TeamAutoConfig[]>();

  /** Grace timers per guildId */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Guilds where auto-record was manually stopped (cleared when channel empties) */
  private suppressedGuilds = new Set<string>();

  /** Timestamp of last connection loss per guildId (kick cooldown) */
  private kickCooldowns = new Map<string, number>();

  /** Guilds where we've already warned about missing permissions (avoid log spam) */
  private permissionWarned = new Set<string>();

  /** Firestore unsubscribe */
  private unsubscribe: (() => void) | null = null;

  start(client: Client, db: Firestore): void {
    this.client = client;

    this.unsubscribe = db.collection('botRegistrations')
      .where('status', '==', 'active')
      .onSnapshot(
        (snapshot) => {
          this.guildConfigs.clear();
          this.permissionWarned.clear();

          for (const doc of snapshot.docs) {
            const data = doc.data();
            const guildId = data.guildId as string | undefined;
            if (!guildId) continue;

            const ar = data.autoRecord as Partial<AutoRecordSettings> | undefined;

            const config: TeamAutoConfig = {
              teamId: doc.id,
              guildId,
              knownPlayers: (data.knownPlayers as Record<string, string>) || {},
              autoRecord: {
                enabled: ar?.enabled ?? false,
                minPlayers: ar?.minPlayers ?? 3,
                platform: ar?.platform ?? 'both',
              },
            };

            const existing = this.guildConfigs.get(guildId) || [];
            existing.push(config);
            this.guildConfigs.set(guildId, existing);
          }

          logger.info(`DiscordAutoRecord: monitoring ${this.guildConfigs.size} guild(s)`);
        },
        (err) => {
          logger.error('DiscordAutoRecord: botRegistrations snapshot error', {
            error: err instanceof Error ? err.message : String(err),
          });
        },
      );

    logger.info('DiscordAutoRecord started');
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;

    for (const timer of this.graceTimers.values()) {
      clearTimeout(timer);
    }
    this.graceTimers.clear();

    this.client = null;
    logger.info('DiscordAutoRecord stopped');
  }

  /** Set suppression for a guild (called by /record stop on auto session — Phase U4). */
  suppress(guildId: string): void {
    this.suppressedGuilds.add(guildId);
    logger.info('DiscordAutoRecord: guild suppressed', { guildId });
  }

  /** Clear suppression for a guild. */
  clearSuppression(guildId: string): void {
    if (this.suppressedGuilds.delete(guildId)) {
      logger.info('DiscordAutoRecord: suppression cleared', { guildId });
    }
  }

  /** Check if a guild is suppressed. */
  isSuppressed(guildId: string): boolean {
    return this.suppressedGuilds.has(guildId);
  }

  async onVoiceStateUpdate(oldState: VoiceState, newState: VoiceState): Promise<void> {
    const guildId = newState.guild.id;

    const configs = this.guildConfigs.get(guildId);
    if (!configs || configs.length === 0) return;

    // Skip multi-team guilds — auto-record is unsafe when multiple teams share a server
    if (configs.length > 1) return;

    const config = configs[0];
    if (!config.autoRecord.enabled) return;
    if (config.autoRecord.platform === 'mumble') return;

    const guild = newState.guild;

    // Check if suppression should be cleared (0 registered members in any voice channel)
    if (this.isSuppressed(guildId)) {
      const totalRegistered = this.countRegisteredMembersInGuild(config, guild);
      if (totalRegistered === 0) {
        this.clearSuppression(guildId);
      }
    }

    const regSession = sessionRegistry.get(`discord:${guildId}`);

    if (regSession && regSession.origin === 'auto') {
      // Active auto-record session — handle grace timer
      this.handleActiveAutoSession(guildId, config, guild, regSession.channelId);
    } else if (!regSession && !isRecording(guildId)) {
      // No active recording — check if we should start one
      await this.handleNoActiveSession(guildId, config, guild);
    }
    // If there's a manual recording active, do nothing — don't interfere
  }

  private async handleNoActiveSession(
    guildId: string,
    config: TeamAutoConfig,
    guild: Guild,
  ): Promise<void> {
    // Check suppression
    if (this.isSuppressed(guildId)) return;

    // Check kick cooldown
    const lastKick = this.kickCooldowns.get(guildId);
    if (lastKick && Date.now() - lastKick < KICK_COOLDOWN_MS) return;

    // Find the voice channel with the most registered members
    const { bestChannel, bestCount } = this.findBestChannel(config, guild);
    if (!bestChannel || bestCount < config.autoRecord.minPlayers) return;

    // Check permissions before attempting to join
    const botMember = guild.members.me;
    if (botMember) {
      const permError = checkVoicePermissions(bestChannel, botMember);
      if (permError) {
        if (!this.permissionWarned.has(guildId)) {
          this.permissionWarned.add(guildId);
          logger.warn('DiscordAutoRecord: missing permissions, skipping', {
            guildId,
            channel: bestChannel.name,
          });
        }
        return;
      }
    }

    logger.info('DiscordAutoRecord: starting auto-record', {
      guildId,
      channel: bestChannel.name,
      registeredMembers: bestCount,
      minPlayers: config.autoRecord.minPlayers,
    });

    const result = await startRecordingSession({
      voiceChannel: bestChannel,
      guild,
      origin: 'auto',
      teamId: config.teamId,
    });

    if (result) {
      // Override onConnectionLost to add kick cooldown before retrying
      result.session.onConnectionLost = () => {
        this.kickCooldowns.set(guildId, Date.now());
        logger.warn('DiscordAutoRecord: connection lost — cooldown activated', {
          guildId,
          sessionId: result.session.sessionId,
        });
        stopRecording(guildId).catch((err) => {
          logger.error('Failed to stop recording after connection loss', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      };
    }
  }

  private handleActiveAutoSession(
    guildId: string,
    config: TeamAutoConfig,
    guild: Guild,
    recordingChannelId: string,
  ): void {
    const registeredCount = this.countRegisteredMembersInChannel(config, guild, recordingChannelId);

    if (registeredCount === 0) {
      // Start grace timer if not already running
      if (!this.graceTimers.has(guildId)) {
        logger.info('DiscordAutoRecord: no registered members — grace timer started', {
          guildId,
        });

        const timer = setTimeout(async () => {
          this.graceTimers.delete(guildId);

          // Double-check session is still an active auto session
          const current = sessionRegistry.get(`discord:${guildId}`);
          if (!current || current.origin !== 'auto') return;

          logger.info('DiscordAutoRecord: grace period expired — stopping', { guildId });
          await performStop(guildId, 'auto-record: all registered members left');

          // After stopping, check if we should start in a different channel
          // (members may have moved rather than left)
          await this.handleNoActiveSession(guildId, config, guild);
        }, GRACE_PERIOD_MS);

        this.graceTimers.set(guildId, timer);
      }
    } else {
      // Registered members still present — cancel grace timer
      this.cancelGraceTimer(guildId);
    }
  }

  private findBestChannel(
    config: TeamAutoConfig,
    guild: Guild,
  ): { bestChannel: VoiceBasedChannel | null; bestCount: number } {
    let bestChannel: VoiceBasedChannel | null = null;
    let bestCount = 0;

    for (const [, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        let count = 0;
        for (const [memberId, member] of channel.members) {
          if (member.user.bot) continue;
          if (memberId in config.knownPlayers) count++;
        }
        if (count > bestCount) {
          bestCount = count;
          bestChannel = channel as VoiceBasedChannel;
        }
      }
    }

    return { bestChannel, bestCount };
  }

  private countRegisteredMembersInChannel(
    config: TeamAutoConfig,
    guild: Guild,
    channelId: string,
  ): number {
    const channel = guild.channels.cache.get(channelId);
    if (!channel) return 0;
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) return 0;

    let count = 0;
    for (const [memberId, member] of (channel as VoiceBasedChannel).members) {
      if (member.user.bot) continue;
      if (memberId in config.knownPlayers) count++;
    }
    return count;
  }

  private countRegisteredMembersInGuild(config: TeamAutoConfig, guild: Guild): number {
    let count = 0;
    for (const [, channel] of guild.channels.cache) {
      if (channel.type === ChannelType.GuildVoice || channel.type === ChannelType.GuildStageVoice) {
        for (const [memberId, member] of channel.members) {
          if (member.user.bot) continue;
          if (memberId in config.knownPlayers) count++;
        }
      }
    }
    return count;
  }

  private cancelGraceTimer(guildId: string): void {
    const timer = this.graceTimers.get(guildId);
    if (!timer) return;

    clearTimeout(timer);
    this.graceTimers.delete(guildId);
    logger.info('DiscordAutoRecord: grace timer cancelled — registered member rejoined', { guildId });
  }
}
