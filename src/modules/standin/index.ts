/**
 * Standin module — Discord DM feedback loop for the MatchScheduler "Find standin" feature.
 *
 * This module is event-driven, no slash commands. It:
 * 1. Listens to Firestore for new standin requests
 * 2. DMs candidates with Yes/No buttons
 * 3. Writes responses back to Firestore (real-time updates in MatchScheduler UI)
 * 4. Sends confirmation/rejection DMs when a standin is chosen
 *
 * Requires: FIREBASE_SERVICE_ACCOUNT env var pointing to a service account JSON.
 * Optional: SCHEDULER_URL for the deep-linked preferences button (default: https://matchscheduler.web.app)
 */

import { Client, Events, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import { initFirestore } from './firestore.js';
import { startListening, stopListening } from './listener.js';
import { isStandinButton, handleStandinButton } from './interactions.js';

let firestoreReady = false;

export const standinModule: BotModule = {
  name: 'standin',

  // No slash commands — this module is fully event-driven
  commands: [],

  async handleCommand(_interaction: ChatInputCommandInteraction): Promise<void> {
    // No commands to handle
  },

  registerEvents(client: Client): void {
    // Handle button interactions from standin DMs
    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      if (!isStandinButton(interaction.customId)) return;
      if (!firestoreReady) {
        await interaction.reply({
          content: 'Standin module is still initializing. Try again in a moment.',
          flags: 64, // Ephemeral
        });
        return;
      }

      try {
        await handleStandinButton(interaction);
      } catch (err) {
        logger.error('Error handling standin button', {
          customId: interaction.customId,
          userId: interaction.user.id,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({
            content: 'Something went wrong. Please try again.',
            flags: 64, // Ephemeral
          }).catch(() => {});
        }
      }
    });
  },

  async onReady(client: Client): Promise<void> {
    // Only initialize if FIREBASE_SERVICE_ACCOUNT is configured
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      logger.info('Standin module skipped — FIREBASE_SERVICE_ACCOUNT not set');
      return;
    }

    try {
      const db = initFirestore();
      firestoreReady = true;
      startListening(db, client);
      logger.info('Standin module loaded');
    } catch (err) {
      logger.error('Failed to initialize standin module', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async onShutdown(): Promise<void> {
    stopListening();
    logger.info('Standin module shut down');
  },
};
