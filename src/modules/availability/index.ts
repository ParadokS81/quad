import { type BotModule } from '../../core/module.js';
import { type Client, type ChatInputCommandInteraction, Events } from 'discord.js';
import { logger } from '../../core/logger.js';
import { initFirestore } from '../standin/firestore.js';
import { startAllListeners, stopAllListeners } from './listener.js';
import { handleButton, handleSelectMenu } from './interactions.js';

export const availabilityModule: BotModule = {
    name: 'availability',
    commands: [],

    async handleCommand(_interaction: ChatInputCommandInteraction): Promise<void> {
        // No slash commands for this module
    },

    registerEvents(client: Client): void {
        client.on(Events.InteractionCreate, async (interaction) => {
            if (interaction.isButton() && interaction.customId.startsWith('avail:')) {
                try {
                    await handleButton(interaction);
                } catch (err) {
                    logger.error('Error handling availability button', {
                        customId: interaction.customId,
                        userId: interaction.user.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: 'Something went wrong. Please try again.',
                            flags: 64,
                        }).catch(() => {});
                    }
                }
                return;
            }
            if (interaction.isStringSelectMenu() && interaction.customId.startsWith('avail:')) {
                try {
                    await handleSelectMenu(interaction);
                } catch (err) {
                    logger.error('Error handling availability select menu', {
                        customId: interaction.customId,
                        userId: interaction.user.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    if (!interaction.replied && !interaction.deferred) {
                        await interaction.reply({
                            content: 'Something went wrong. Please try again.',
                            flags: 64,
                        }).catch(() => {});
                    }
                }
                return;
            }
        });
        logger.info('Availability module: events registered');
    },

    async onReady(client: Client): Promise<void> {
        if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
            logger.info('Availability module skipped — FIREBASE_SERVICE_ACCOUNT not set');
            return;
        }

        try {
            const db = initFirestore();
            await startAllListeners(db, client);
            logger.info('Availability module: ready, listeners started');
        } catch (err) {
            logger.error('Failed to initialize availability module', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    },

    async onShutdown(): Promise<void> {
        stopAllListeners();
        logger.info('Availability module: shutdown, listeners stopped');
    },
};
