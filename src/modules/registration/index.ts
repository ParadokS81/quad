/**
 * Registration module — /register command for multi-clan bot registration.
 *
 * Completes a pending botRegistration created by MatchScheduler (Phase 1a)
 * by linking a Discord guild to a team. Requires Firebase to be configured.
 */

import { Client, SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import { type BotModule } from '../../core/module.js';
import { logger } from '../../core/logger.js';
import { initFirestore } from '../standin/firestore.js';
import { handleRegister } from './register.js';
import { startDisconnectListener, stopDisconnectListener } from './disconnect-listener.js';

export { getRegistrationForGuild, type BotRegistration } from './register.js';

let firestoreReady = false;

const registerCommand = new SlashCommandBuilder()
  .setName('register')
  .setDescription('Link this Discord server to your team on MatchScheduler');

export const registrationModule: BotModule = {
  name: 'registration',

  commands: [registerCommand as SlashCommandBuilder],

  async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!firestoreReady) {
      await interaction.reply({
        content: 'Registration module is not available — Firebase is not configured.',
        flags: 64, // Ephemeral
      });
      return;
    }

    await handleRegister(interaction);
  },

  registerEvents(_client: Client): void {
    // No event listeners needed
  },

  async onReady(client: Client): Promise<void> {
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
      logger.info('Registration module skipped — FIREBASE_SERVICE_ACCOUNT not set');
      return;
    }

    try {
      const db = initFirestore(); // Idempotent — reuses existing instance if standin already initialized
      firestoreReady = true;
      startDisconnectListener(db, client);
      logger.info('Registration module loaded');
    } catch (err) {
      logger.error('Failed to initialize registration module', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  async onShutdown(): Promise<void> {
    stopDisconnectListener();
  },
};
