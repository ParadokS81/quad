import { Client, ChatInputCommandInteraction, Events, ChannelType } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import {
  recordCommand,
  handleRecordCommand,
  isRecording,
  getRecordingChannelId,
  getActiveSession,
  getActiveSessions,
  stopRecording,
  performStop,
  fireParticipantChangeCallbacks,
} from './commands/record.js';
import { initSessionTracker, cleanupInterruptedSessions, shutdownSessionTracker } from './firestore-tracker.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const recordingModule: BotModule = {
  name: 'recording',

  commands: [recordCommand],

  handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    return handleRecordCommand(interaction);
  },

  registerEvents(client: Client): void {
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      // Ignore bot's own voice state changes
      if (newState.member?.user.bot) return;

      const userId = newState.id;

      // Check if the user left or joined a channel that has an active recording
      // A user could leave one guild's recording channel or join another's
      const oldGuildId = oldState.guild.id;
      const newGuildId = newState.guild.id;

      // Check if user left a recording channel
      if (oldState.channelId && isRecording(oldGuildId)) {
        const recordingChannelId = getRecordingChannelId(oldGuildId);
        if (oldState.channelId === recordingChannelId && newState.channelId !== recordingChannelId) {
          const username = oldState.member?.user.username ?? userId;
          logger.info(`User left recording channel: ${username}`, { userId, channelId: recordingChannelId, guildId: oldGuildId });

          // Check if channel is now empty (no non-bot users) → start idle timer
          const channel = client.channels.cache.get(recordingChannelId);
          if (channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice) {
            const nonBotMembers = channel.members.filter((m) => !m.user.bot);
            if (nonBotMembers.size === 0) {
              startIdleTimer(oldGuildId);
            }
            // Notify participant change
            fireParticipantChangeCallbacks(oldGuildId, nonBotMembers.map((m) => m.displayName));
          }
        }
      }

      // Check if user joined a recording channel
      if (newState.channelId && isRecording(newGuildId)) {
        const recordingChannelId = getRecordingChannelId(newGuildId);
        if (newState.channelId === recordingChannelId && oldState.channelId !== recordingChannelId) {
          // Someone rejoined — cancel idle timer
          cancelIdleTimer(newGuildId);

          const session = getActiveSession(newGuildId);
          if (session?.hasUser(userId)) {
            // User rejoined — reattach their opus stream to the existing track
            session.reattachUser(userId);
          }
          // If they don't have a track yet, the speaking event handler will create one

          // Notify participant change
          const channel = client.channels.cache.get(recordingChannelId);
          if (channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice) {
            const participants = channel.members.filter((m) => !m.user.bot).map((m) => m.displayName);
            fireParticipantChangeCallbacks(newGuildId, participants);
          }
        }
      }
    });
  },

  async onReady(client: Client): Promise<void> {
    // Clean up any stale @discordjs/voice internal state from a previous session.
    // Only destroys existing VoiceConnection objects — does NOT create temp connections
    // (which would start aborted DAVE handshakes and poison subsequent join attempts).
    // If the bot is visually "stuck" in a voice channel, the next /record start will
    // reclaim it via joinVoiceChannel() which handles the stale state properly.
    for (const guild of client.guilds.cache.values()) {
      const existingConn = getVoiceConnection(guild.id);
      if (existingConn) {
        logger.info('Cleaning up stale voice connection on startup', { guild: guild.name });
        try { existingConn.destroy(); } catch { /* */ }
      }
      if (guild.members.me?.voice.channelId) {
        logger.warn('Bot appears stuck in voice channel (will be reclaimed on next /record start)', {
          guild: guild.name,
          channel: guild.members.me.voice.channel?.name,
        });
      }
    }

    // Initialize Firestore session tracker if Firebase is configured
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
      try {
        const { initFirestore } = await import('../standin/firestore.js');
        const db = initFirestore();
        initSessionTracker(db);
        await cleanupInterruptedSessions();
      } catch (err) {
        logger.warn('Firestore session tracker not started — Firebase init failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Recording module loaded');
  },

  async onShutdown(): Promise<void> {
    // Cancel all idle timers
    for (const [guildId] of idleTimers) {
      cancelIdleTimer(guildId);
    }

    // Mark tracked sessions as completed in Firestore before stopping
    await shutdownSessionTracker();

    // Stop all active recordings
    const sessions = getActiveSessions();
    for (const [guildId] of sessions) {
      await stopRecording(guildId);
    }
    logger.info('Recording module shut down');
  },
};

function startIdleTimer(guildId: string): void {
  if (idleTimers.has(guildId)) return; // Already running for this guild

  logger.info('Channel empty — auto-stop in 30 minutes if no one rejoins', { guildId });
  const timer = setTimeout(async () => {
    idleTimers.delete(guildId);
    if (!isRecording(guildId)) return;

    logger.info('Idle timeout reached (30m) — auto-stopping recording', { guildId });
    await performStop(guildId, 'idle timeout (channel empty for 30 minutes)');
  }, IDLE_TIMEOUT_MS);
  idleTimers.set(guildId, timer);
}

function cancelIdleTimer(guildId: string): void {
  const timer = idleTimers.get(guildId);
  if (!timer) return;

  clearTimeout(timer);
  idleTimers.delete(guildId);
  logger.info('Idle timer cancelled — user rejoined', { guildId });
}
