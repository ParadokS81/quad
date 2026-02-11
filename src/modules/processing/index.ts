/**
 * Processing module — processes recording sessions through the voice analysis pipeline.
 *
 * Two-stage design:
 *   Fast (auto, seconds): parse metadata → QW Hub API → pair matches → split audio
 *   Slow (opt-in, hours):  transcribe → merge timelines → Claude analysis
 */

import { type Client, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { loadConfig } from '../../core/config.js';
import { logger } from '../../core/logger.js';
import { processCommand, handleProcessCommand } from './commands/process.js';
import { onRecordingStop } from '../recording/commands/record.js';
import { runFastPipeline } from './pipeline.js';

export const processingModule: BotModule = {
  name: 'processing',

  commands: [processCommand],

  handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    return handleProcessCommand(interaction);
  },

  registerEvents(_client: Client): void {
    // Register auto-trigger: after recording stops, run fast pipeline if enabled
    const config = loadConfig();
    if (config.processing.processingAuto) {
      onRecordingStop((sessionDir: string, sessionId: string) => {
        logger.info('Auto-triggering fast pipeline after recording stop', { sessionId, sessionDir });

        runFastPipeline(sessionDir, config.processing)
          .then((result) => {
            logger.info('Auto fast pipeline complete', {
              sessionId,
              matches: result.pairings.length,
              segments: result.segments.length,
            });
          })
          .catch((err) => {
            logger.error('Auto fast pipeline failed', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
      });
      logger.info('Processing auto-trigger registered');
    }
  },

  async onReady(_client: Client): Promise<void> {
    logger.info('Processing module loaded');
  },

  async onShutdown(): Promise<void> {
    logger.info('Processing module shut down');
  },
};
