/**
 * Scheduler module — delivers challenge notifications from MatchScheduler to Discord.
 *
 * This module is event-driven, no slash commands. It:
 * 1. Listens to Firestore `notifications` collection for pending challenge notifications
 * 2. Sends embeds to the opponent's channel (or DM fallback) and proposer's channel
 * 3. Writes delivery status back to Firestore
 * 4. Syncs available text channels to botRegistrations for MatchScheduler's dropdown
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT env var pointing to a service account JSON.
 */

import { type Client, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import { initFirestore } from '../standin/firestore.js';
import { startListening, stopListening } from './listener.js';
import { syncAllGuildChannels } from './channels.js';
import { startCreateChannelListener, stopCreateChannelListener } from './create-channel-listener.js';

export const schedulerModule: BotModule = {
  name: 'scheduler',

  // No slash commands — fully event-driven
  commands: [],

  async handleCommand(_interaction: ChatInputCommandInteraction): Promise<void> {
    // No commands to handle
  },

  registerEvents(_client: Client): void {
    // No button interactions needed for v1
  },

  async onReady(client: Client): Promise<void> {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      logger.info('Scheduler module skipped — FIREBASE_SERVICE_ACCOUNT not set');
      return;
    }

    try {
      const db = initFirestore(); // Idempotent — reuses existing instance
      startListening(db, client);
      startCreateChannelListener(db, client);

      // Sync channel lists for all registered guilds
      await syncAllGuildChannels(db, client);

      logger.info('Scheduler module loaded');
    } catch (err) {
      logger.error('Failed to initialize scheduler module', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async onShutdown(): Promise<void> {
    stopCreateChannelListener();
    stopListening();
    logger.info('Scheduler module shut down');
  },
};
