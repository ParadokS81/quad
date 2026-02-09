import { Client, ChatInputCommandInteraction, Events } from 'discord.js';
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

  async onReady(_client: Client): Promise<void> {
    logger.info('Recording module loaded');
  },

  async onShutdown(): Promise<void> {
    if (isRecording()) {
      await stopRecording();
    }
    logger.info('Recording module shut down');
  },
};
