/**
 * Processing module — processes recording sessions through the voice analysis pipeline.
 *
 * Two-stage design:
 *   Fast (auto, seconds): parse metadata → QW Hub API → pair matches → split audio
 *   Slow (opt-in, hours):  transcribe → merge timelines → Claude analysis
 */

import { type Client, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import { processCommand, handleProcessCommand } from './commands/process.js';

export const processingModule: BotModule = {
  name: 'processing',

  commands: [processCommand],

  handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    return handleProcessCommand(interaction);
  },

  registerEvents(_client: Client): void {
    // Processing is triggered by commands or auto-trigger after recording stops.
    // No Discord events needed.
  },

  async onReady(_client: Client): Promise<void> {
    logger.info('Processing module loaded');
  },

  async onShutdown(): Promise<void> {
    logger.info('Processing module shut down');
  },
};
