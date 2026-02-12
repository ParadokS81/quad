import { Client, ChatInputCommandInteraction, Events } from 'discord.js';
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
} from './commands/record.js';

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
      }

      if (joinedRecordingChannel) {
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
    if (isRecording()) {
      await stopRecording();
    }
    logger.info('Recording module shut down');
  },
};
