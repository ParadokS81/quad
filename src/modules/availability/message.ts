/**
 * Message management for the persistent schedule grid.
 *
 * Handles posting new messages, recovering from deleted messages,
 * and updating existing messages with fresh grid images.
 */

import {
    type Client,
    type TextChannel,
    AttachmentBuilder,
    type EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type StringSelectMenuBuilder,
} from 'discord.js';
import { getDb } from '../standin/firestore.js';
import { logger } from '../../core/logger.js';
import { buildDaySelectMenu } from './interactions.js';

// Discord API error codes
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

function getDiscordErrorCode(err: unknown): number | undefined {
    return (err as { code?: number }).code;
}

/**
 * Post a new message or recover the existing one.
 *
 * Flow:
 * 1. Read scheduleMessageId from botRegistrations
 * 2. Try to fetch the channel → if Unknown Channel: clear config, return null
 * 3. Try to fetch the message by stored ID → if found: edit with new content
 * 4. If not found or no ID stored: post new message
 * 5. Write scheduleMessageId back to Firestore
 * 6. Return the message ID
 */
export async function postOrRecoverMessage(
    client: Client,
    channelId: string,
    teamId: string,
    imageBuffer: Buffer,
    embed: EmbedBuilder,
): Promise<string | null> {
    const db = getDb();
    const regDoc = await db.collection('botRegistrations').doc(teamId).get();
    if (!regDoc.exists) return null;

    const storedMessageId: string | null = regDoc.data()!.scheduleMessageId ?? null;

    // Fetch channel
    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !fetched.isTextBased()) {
            logger.warn('Schedule channel not text-based or not found', { channelId, teamId });
            return null;
        }
        channel = fetched as TextChannel;
    } catch (err) {
        if (getDiscordErrorCode(err) === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted, clearing config', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
            });
        } else {
            logger.error('Failed to fetch schedule channel', {
                channelId, teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'schedule.png' });

    const components = buildActionRows(teamId);
    const payload = { embeds: [embed], files: [attachment], components };

    // If we have a stored message ID, try to edit it
    if (storedMessageId) {
        try {
            const message = await channel.messages.fetch(storedMessageId);
            await message.edit(payload);
            return storedMessageId;
        } catch (err) {
            if (getDiscordErrorCode(err) !== UNKNOWN_MESSAGE) {
                logger.error('Failed to edit schedule message', {
                    teamId, messageId: storedMessageId,
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            }
            // Unknown Message (10008) — fall through to post new
            logger.info('Stored schedule message gone, posting fresh', { teamId });
        }
    }

    // Post new message
    try {
        const newMessage = await channel.send(payload);
        await db.collection('botRegistrations').doc(teamId).update({
            scheduleMessageId: newMessage.id,
        });
        logger.info('Posted new schedule message', { teamId, channelId, messageId: newMessage.id });
        return newMessage.id;
    } catch (err) {
        logger.error('Failed to post schedule message', {
            teamId, channelId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Update an existing message with a fresh grid image.
 *
 * Returns the message ID on success, or null if recovery is needed
 * (message deleted, channel gone).
 */
export async function updateMessage(
    client: Client,
    channelId: string,
    messageId: string,
    teamId: string,
    imageBuffer: Buffer,
    embed: EmbedBuilder,
): Promise<string | null> {
    const db = getDb();

    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !fetched.isTextBased()) return null;
        channel = fetched as TextChannel;
    } catch (err) {
        if (getDiscordErrorCode(err) === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted during update', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
            });
        } else {
            logger.error('Failed to fetch channel for update', {
                channelId, teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'schedule.png' });

    const components = buildActionRows(teamId);

    try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [embed], files: [attachment], components });
        return messageId;
    } catch (err) {
        const code = getDiscordErrorCode(err);
        if (code === UNKNOWN_MESSAGE) {
            // Message deleted — caller should use postOrRecoverMessage
            logger.info('Schedule message deleted, needs recovery', { teamId, messageId });
            return null;
        }
        if (code === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted during message edit', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
            });
            return null;
        }
        logger.error('Failed to edit schedule message', {
            teamId, messageId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

// ── Action rows for the persistent message ──────────────────────────────────

function buildActionRows(teamId: string): Array<ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>> {
    const clearButton = new ButtonBuilder()
        .setCustomId(`avail:clearWeek:${teamId}`)
        .setLabel('\u2212Me This Week')
        .setStyle(ButtonStyle.Secondary);

    const daySelect = buildDaySelectMenu(`avail:editDay:${teamId}`);

    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(clearButton);
    const row2 = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(daySelect);

    return [row1, row2];
}
