/**
 * Message management for the persistent schedule grids.
 *
 * Handles posting new messages, recovering from deleted messages,
 * and updating existing messages with fresh grid images.
 *
 * Two grid messages per team: next week (top) and current week (bottom).
 * Each has its own "Edit day..." dropdown scoped to its week.
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
import { dmRegistrantAboutPermissions } from '../registration/register.js';
import { getNextWeekId } from './time.js';
import { buildDaySelectMenu } from './interactions.js';

// Discord API error codes
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;
const MISSING_PERMISSIONS = 50013;

function getDiscordErrorCode(err: unknown): number | undefined {
    return (err as { code?: number }).code;
}

/** Firestore field name for the message ID based on week type */
function messageIdField(isNextWeek: boolean): string {
    return isNextWeek ? 'nextWeekMessageId' : 'scheduleMessageId';
}

/**
 * Post a new message or recover the existing one.
 *
 * Flow:
 * 1. Read message ID from botRegistrations (scheduleMessageId or nextWeekMessageId)
 * 2. Try to fetch the channel → if Unknown Channel: clear config, return null
 * 3. Try to fetch the message by stored ID → if found: edit with new content
 * 4. If not found or no ID stored: post new message
 * 5. Write message ID back to Firestore
 * 6. Return the message ID
 */
export async function postOrRecoverMessage(
    client: Client,
    channelId: string,
    teamId: string,
    imageBuffer: Buffer,
    isNextWeek = false,
): Promise<string | null> {
    const db = getDb();
    const regDoc = await db.collection('botRegistrations').doc(teamId).get();
    if (!regDoc.exists) return null;

    const field = messageIdField(isNextWeek);
    const storedMessageId: string | null = regDoc.data()![field] ?? null;

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
        const code = getDiscordErrorCode(err);
        if (code === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted, clearing config', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
                nextWeekMessageId: null,
            });
        } else if (code === MISSING_PERMISSIONS) {
            logger.warn('Missing permissions to access schedule channel', { channelId, teamId });
            await dmRegistrantAboutPermissions(client, teamId, channelId);
        } else {
            logger.error('Failed to fetch schedule channel', {
                channelId, teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'schedule.png' });

    const components = buildActionRows(teamId, isNextWeek);
    const payload = { embeds: [] as EmbedBuilder[], files: [attachment], components };

    // If we have a stored message ID, try to edit it
    if (storedMessageId) {
        try {
            const message = await channel.messages.fetch(storedMessageId);
            await message.edit(payload);
            logger.debug('Edited grid message in place', { teamId, messageId: storedMessageId, isNextWeek });
            return storedMessageId;
        } catch (err) {
            if (getDiscordErrorCode(err) !== UNKNOWN_MESSAGE) {
                logger.error('Failed to edit schedule message', {
                    teamId, messageId: storedMessageId, isNextWeek,
                    error: err instanceof Error ? err.message : String(err),
                });
                return null;
            }
            // Unknown Message (10008) — fall through to post new
            logger.info('Stored schedule message gone, posting fresh', { teamId, isNextWeek });
        }
    }

    // Post new message
    try {
        const newMessage = await channel.send(payload);
        await db.collection('botRegistrations').doc(teamId).update({
            [field]: newMessage.id,
        });
        logger.info('Posted new schedule message', { teamId, channelId, messageId: newMessage.id, isNextWeek });
        return newMessage.id;
    } catch (err) {
        if (getDiscordErrorCode(err) === MISSING_PERMISSIONS) {
            logger.warn('Missing permissions to post schedule message', { teamId, channelId, isNextWeek });
            await dmRegistrantAboutPermissions(client, teamId, channelId);
        } else {
            logger.error('Failed to post schedule message', {
                teamId, channelId, isNextWeek, error: err instanceof Error ? err.message : String(err),
            });
        }
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
    isNextWeek = false,
): Promise<string | null> {
    const db = getDb();

    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !fetched.isTextBased()) return null;
        channel = fetched as TextChannel;
    } catch (err) {
        const code = getDiscordErrorCode(err);
        if (code === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted during update', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
                nextWeekMessageId: null,
            });
        } else if (code === MISSING_PERMISSIONS) {
            logger.warn('Missing permissions to access schedule channel during update', { channelId, teamId });
            await dmRegistrantAboutPermissions(client, teamId, channelId);
        } else {
            logger.error('Failed to fetch channel for update', {
                channelId, teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
        return null;
    }

    const attachment = new AttachmentBuilder(imageBuffer, { name: 'schedule.png' });

    const components = buildActionRows(teamId, isNextWeek);

    try {
        const message = await channel.messages.fetch(messageId);
        await message.edit({ embeds: [], files: [attachment], components });
        return messageId;
    } catch (err) {
        const code = getDiscordErrorCode(err);
        if (code === UNKNOWN_MESSAGE) {
            // Message deleted — caller should use postOrRecoverMessage
            logger.info('Schedule message deleted, needs recovery', { teamId, messageId, isNextWeek });
            return null;
        }
        if (code === UNKNOWN_CHANNEL) {
            logger.warn('Schedule channel deleted during message edit', { channelId, teamId });
            await db.collection('botRegistrations').doc(teamId).update({
                scheduleChannelId: null,
                scheduleMessageId: null,
                nextWeekMessageId: null,
            });
            return null;
        }
        if (code === MISSING_PERMISSIONS) {
            logger.warn('Missing permissions to edit schedule message', { channelId, teamId });
            await dmRegistrantAboutPermissions(client, teamId, channelId);
            return null;
        }
        logger.error('Failed to edit schedule message', {
            teamId, messageId, isNextWeek, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Sync an array of card messages (one per match/proposal).
 *
 * Each card is its own Discord message: one image + one button row.
 * This function edits existing messages, posts new ones, and deletes
 * excess messages from the old set.
 *
 * Returns the new array of message IDs (same length as cards, or empty).
 */
export async function syncCardMessages(
    client: Client,
    channelId: string,
    existingIds: string[],
    cards: Array<{ buffer: Buffer; button: ActionRowBuilder<ButtonBuilder> }>,
    teamId?: string,
): Promise<string[]> {
    let channel: TextChannel;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !fetched.isTextBased()) return [];
        channel = fetched as TextChannel;
    } catch (err) {
        if (getDiscordErrorCode(err) === MISSING_PERMISSIONS && teamId) {
            logger.warn('Missing permissions to access channel for card messages', { channelId, teamId });
            await dmRegistrantAboutPermissions(client, teamId, channelId);
        }
        return [];
    }

    // No cards — delete all existing messages
    if (cards.length === 0) {
        for (const id of existingIds) {
            try {
                const msg = await channel.messages.fetch(id);
                await msg.delete();
            } catch { /* already gone */ }
        }
        return [];
    }

    const newIds: string[] = [];

    for (let i = 0; i < cards.length; i++) {
        const { buffer, button } = cards[i];
        const attachment = new AttachmentBuilder(buffer, { name: `card-${i}.png` });
        const payload = { files: [attachment], embeds: [], components: [button] };

        // Try to edit existing message at this index
        if (i < existingIds.length && existingIds[i]) {
            try {
                const msg = await channel.messages.fetch(existingIds[i]);
                await msg.edit(payload);
                newIds.push(existingIds[i]);
                continue;
            } catch {
                // Message gone — post new below
            }
        }

        // Post new message
        try {
            const newMsg = await channel.send(payload);
            newIds.push(newMsg.id);
        } catch (err) {
            if (getDiscordErrorCode(err) === MISSING_PERMISSIONS && teamId) {
                logger.warn('Missing permissions to post card message', { channelId, teamId });
                await dmRegistrantAboutPermissions(client, teamId, channelId);
            }
            // Skip this card regardless
        }
    }

    // Delete excess old messages (if we now have fewer cards than before)
    const deleted = existingIds.length - cards.length;
    for (let i = cards.length; i < existingIds.length; i++) {
        if (existingIds[i]) {
            try {
                const msg = await channel.messages.fetch(existingIds[i]);
                await msg.delete();
            } catch { /* already gone */ }
        }
    }

    const edited = newIds.filter((id, i) => i < existingIds.length && id === existingIds[i]).length;
    const posted = newIds.length - edited;
    if (posted > 0 || deleted > 0) {
        logger.info('Card sync', {
            channelId, teamId,
            total: cards.length, edited, posted, deleted: Math.max(0, deleted),
        });
    }

    return newIds;
}

// ── Action rows for the persistent message ──────────────────────────────────

function buildActionRows(teamId: string, isNextWeek = false): Array<ActionRowBuilder<any>> {
    const customId = isNextWeek
        ? `avail:editDay:${teamId}:next`
        : `avail:editDay:${teamId}`;
    const weekId = isNextWeek ? getNextWeekId() : undefined;
    const daySelect = buildDaySelectMenu(customId, weekId);
    const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(daySelect);

    const templateRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId(`avail:saveTemplate:${teamId}:${isNextWeek ? getNextWeekId() : 'current'}`)
            .setLabel('Save Template')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`avail:options:${teamId}`)
            .setLabel('⚙ Options')
            .setStyle(ButtonStyle.Secondary),
    );

    return [selectRow, templateRow];
}
