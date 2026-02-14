import { Client, ChatInputCommandInteraction, Events, ChannelType } from 'discord.js';
import { getVoiceConnection } from '@discordjs/voice';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import {
  recordCommand,
  handleRecordCommand,
  isRecording,
  getRecordingChannelId,
  getRecordingGuildId,
  getActiveSession,
  stopRecording,
  performStop,
} from './commands/record.js';

const IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
let idleTimer: ReturnType<typeof setTimeout> | null = null;

export const recordingModule: BotModule = {
  name: 'recording',

  commands: [recordCommand],

  handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    return handleRecordCommand(interaction);
  },

  registerEvents(client: Client): void {
    client.on(Events.VoiceStateUpdate, (oldState, newState) => {
      if (!isRecording()) return;

      const channelId = getRecordingChannelId();
      const guildId = getRecordingGuildId();
      if (!channelId || !guildId) return;

      // Ignore bot's own voice state changes
      if (newState.member?.user.bot) return;

      const userId = newState.id;
      const leftRecordingChannel = oldState.channelId === channelId && newState.channelId !== channelId;
      const joinedRecordingChannel = newState.channelId === channelId && oldState.channelId !== channelId;

      if (leftRecordingChannel) {
        const username = oldState.member?.user.username ?? userId;
        logger.info(`User left recording channel: ${username}`, { userId, channelId });
        // Don't close their track — silence timer keeps the file continuous

        // Check if channel is now empty (no non-bot users) → start idle timer
        const channel = client.channels.cache.get(channelId);
        if (channel?.type === ChannelType.GuildVoice || channel?.type === ChannelType.GuildStageVoice) {
          const nonBotMembers = channel.members.filter((m) => !m.user.bot).size;
          if (nonBotMembers === 0) {
            startIdleTimer();
          }
        }
      }

      if (joinedRecordingChannel) {
        // Someone rejoined — cancel idle timer
        cancelIdleTimer();

        const session = getActiveSession();
        if (session?.hasUser(userId)) {
          // User rejoined — reattach their opus stream to the existing track
          session.reattachUser(userId);
        }
        // If they don't have a track yet, the speaking event handler will create one
      }
    });
  },

  async onReady(client: Client): Promise<void> {
    // Clean up any stale voice connections from a previous session (e.g., after restart).
    // Gateway-level: the bot may still be in a voice channel from before the restart.
    for (const guild of client.guilds.cache.values()) {
      const me = guild.members.me;
      if (me?.voice.channelId) {
        logger.warn('Disconnecting from stale voice channel on startup', {
          guild: guild.name,
          channel: me.voice.channel?.name,
        });
        await me.voice.disconnect().catch(() => {});
      }
      // Also clean up @discordjs/voice internal state if any
      const connection = getVoiceConnection(guild.id);
      if (connection) connection.destroy();
    }
    logger.info('Recording module loaded');
  },

  async onShutdown(): Promise<void> {
    cancelIdleTimer();
    if (isRecording()) {
      await stopRecording();
    }
    logger.info('Recording module shut down');
  },
};

function startIdleTimer(): void {
  if (idleTimer) return; // Already running

  logger.info('Channel empty — auto-stop in 30 minutes if no one rejoins');
  idleTimer = setTimeout(async () => {
    idleTimer = null;
    if (!isRecording()) return;

    logger.info('Idle timeout reached (30m) — auto-stopping recording');
    await performStop('idle timeout (channel empty for 30 minutes)');
  }, IDLE_TIMEOUT_MS);
}

function cancelIdleTimer(): void {
  if (!idleTimer) return;

  clearTimeout(idleTimer);
  idleTimer = null;
  logger.info('Idle timer cancelled — user rejoined');
}
