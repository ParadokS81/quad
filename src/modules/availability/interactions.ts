/**
 * Interaction handlers for the persistent schedule message.
 *
 * Handles:
 * - avail:editDay:{teamId}      — Day select menu on persistent message
 * - avail:editSlots:{teamId}:{cetDay} — Time slot multi-select on ephemeral
 */

import {
    type ButtonInteraction,
    type StringSelectMenuInteraction,
    StringSelectMenuBuilder,
    ActionRowBuilder,
    MessageFlags,
} from 'discord.js';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { getDb } from '../standin/firestore.js';
import { resolveUser } from './user-resolver.js';
import {
    getCurrentWeekId,
    getWeekDates,
    cetToUtcSlotId,
    isDayPast,
    isSlotPast,
    formatCetTime,
    CET_SLOT_TIMES,
} from './time.js';
import { getTeamAvailability } from './listener.js';

const DAY_NAMES: Record<string, string> = {
    mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday',
    fri: 'Friday', sat: 'Saturday', sun: 'Sunday',
};

function getOrdinal(n: number): string {
    if (n >= 11 && n <= 13) return 'th';
    switch (n % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

function capitalize(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Routing ─────────────────────────────────────────────────────────────────

export async function handleButton(interaction: ButtonInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith('avail:clearWeek:')) {
        await handleClearWeek(interaction);
    } else {
        await interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral });
    }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith('avail:editDay:')) {
        await handleDaySelect(interaction);
    } else if (customId.startsWith('avail:editSlots:')) {
        await handleSlotSelect(interaction);
    } else {
        await interaction.reply({ content: 'Unknown menu.', flags: MessageFlags.Ephemeral });
    }
}

// ── Edit Day Flow ───────────────────────────────────────────────────────────

/**
 * Step 1: User selects a day from the persistent message or "edit another" menu.
 * Shows an ephemeral with time slot checkboxes, current slots pre-checked.
 */
async function handleDaySelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const teamId = extractTeamId(interaction.customId);
    const cetDay = interaction.values[0];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const weekId = getCurrentWeekId();
    if (isDayPast(cetDay, weekId)) {
        await interaction.reply({
            content: 'This day has already passed.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const currentSlots = getCurrentUserSlots(teamId, user.uid, cetDay);

    // Filter out past time slots for today, show all for future days
    const options = CET_SLOT_TIMES
        .filter(time => !isSlotPast(cetToUtcSlotId(cetDay, time), weekId))
        .map(time => ({
            label: `${formatCetTime(time)} CET`,
            value: time,
            default: currentSlots.includes(time),
        }));

    if (options.length === 0) {
        await interaction.reply({
            content: 'All time slots for this day have passed.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const select = new StringSelectMenuBuilder()
        .setCustomId(`avail:editSlots:${teamId}:${cetDay}`)
        .setPlaceholder('Select times...')
        .setMinValues(0)
        .setMaxValues(options.length)
        .addOptions(options);

    const dayLabel = formatDayLabel(cetDay, weekId);

    await interaction.reply({
        content: `**${dayLabel}**\nSelect which times you're available:`,
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select)],
        flags: MessageFlags.Ephemeral,
    });
}

/**
 * Step 2: User submits time slot selections. Diffs against current state,
 * writes to Firestore, and shows confirmation with "edit another day" option.
 */
async function handleSlotSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const cetDay = parts[3];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const selectedCetTimes = interaction.values;
    const currentSlots = getCurrentUserSlots(teamId, user.uid, cetDay);

    const toAdd = selectedCetTimes.filter(t => !currentSlots.includes(t));
    const toRemove = currentSlots.filter(t => !selectedCetTimes.includes(t));

    if (toAdd.length === 0 && toRemove.length === 0) {
        await interaction.update({ content: 'No changes made.', components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
        return;
    }

    const weekId = getCurrentWeekId();
    const docId = `${teamId}_${weekId}`;
    const updateData: Record<string, any> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };

    for (const cetTime of toAdd) {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        updateData[`slots.${utcSlotId}`] = FieldValue.arrayUnion(user.uid);
        updateData[`unavailable.${utcSlotId}`] = FieldValue.arrayRemove(user.uid);
    }
    for (const cetTime of toRemove) {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        updateData[`slots.${utcSlotId}`] = FieldValue.arrayRemove(user.uid);
    }

    try {
        const db = getDb();
        const docRef = db.collection('availability').doc(docId);
        const doc = await docRef.get();
        if (!doc.exists) {
            await docRef.set({ teamId, weekId, slots: {}, unavailable: {}, ...updateData });
        } else {
            await docRef.update(updateData);
        }
    } catch (err) {
        logger.error('Failed to update availability', {
            teamId, userId: user.uid,
            error: err instanceof Error ? err.message : String(err),
        });
        await interaction.update({ content: 'Failed to update — try again.', components: [] });
        return;
    }

    const addedStr = toAdd.map(t => formatCetTime(t)).join(', ');
    const removedStr = toRemove.map(t => formatCetTime(t)).join(', ');
    let summary = `**${DAY_NAMES[cetDay] ?? capitalize(cetDay)}** updated`;
    if (addedStr) summary += `\nAdded: ${addedStr}`;
    if (removedStr) summary += `\nRemoved: ${removedStr}`;

    await interaction.update({ content: summary, components: [] });

    // Auto-delete confirmation after 5 seconds to keep channel clean
    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 5000);

    logger.info('Availability updated via Discord', {
        teamId, userId: user.uid, cetDay, added: toAdd.length, removed: toRemove.length,
    });
}

// ── Clear Week Flow ─────────────────────────────────────────────────────────

async function handleClearWeek(interaction: ButtonInteraction): Promise<void> {
    const teamId = extractTeamId(interaction.customId);

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const weekId = getCurrentWeekId();
    const docId = `${teamId}_${weekId}`;
    const db = getDb();
    const docRef = db.collection('availability').doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
        await interaction.reply({
            content: 'You have no availability set this week.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const data = doc.data()!;
    const updateData: Record<string, any> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };

    for (const [slotId, users] of Object.entries(data.slots || {})) {
        if ((users as string[]).includes(user.uid)) {
            updateData[`slots.${slotId}`] = FieldValue.arrayRemove(user.uid);
        }
    }
    for (const [slotId, users] of Object.entries(data.unavailable || {})) {
        if ((users as string[]).includes(user.uid)) {
            updateData[`unavailable.${slotId}`] = FieldValue.arrayRemove(user.uid);
        }
    }

    if (Object.keys(updateData).length <= 1) {
        await interaction.reply({
            content: 'You have no availability set this week.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    try {
        await docRef.update(updateData);
    } catch (err) {
        logger.error('Failed to clear availability', {
            teamId, userId: user.uid,
            error: err instanceof Error ? err.message : String(err),
        });
        await interaction.reply({
            content: 'Failed to clear — try again.',
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const weekNum = weekId.split('-')[1];
    await interaction.reply({
        content: `Cleared all your availability for Week ${weekNum}.`,
        flags: MessageFlags.Ephemeral,
    });

    logger.info('Availability cleared via Discord', { teamId, userId: user.uid, weekId });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function extractTeamId(customId: string): string {
    // avail:action:teamId or avail:action:teamId:extra
    return customId.split(':')[2];
}

/**
 * Get current CET time slots the user is available for on a given day.
 * Reads from the cached listener state — no extra Firestore read.
 */
function getCurrentUserSlots(teamId: string, uid: string, cetDay: string): string[] {
    const availability = getTeamAvailability(teamId);
    if (!availability) return [];

    return CET_SLOT_TIMES.filter(cetTime => {
        const utcSlotId = cetToUtcSlotId(cetDay, cetTime);
        return (availability.slots[utcSlotId] || []).includes(uid);
    });
}

function formatDayLabel(cetDay: string, weekId: string): string {
    const weekDates = getWeekDates(weekId);
    const dayNames = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
    const dayIdx = dayNames.indexOf(cetDay);
    if (dayIdx === -1) return DAY_NAMES[cetDay] ?? capitalize(cetDay);

    const info = weekDates[dayIdx];
    if (!info) return DAY_NAMES[cetDay] ?? capitalize(cetDay);

    return `${DAY_NAMES[cetDay]} ${info.month} ${info.date}${getOrdinal(info.date)}`;
}

/**
 * Build the day select menu for editing availability.
 * Used on both the persistent message and the "edit another day" ephemeral.
 */
export function buildDaySelectMenu(customId: string): StringSelectMenuBuilder {
    const weekId = getCurrentWeekId();
    const weekDates = getWeekDates(weekId);

    const options = weekDates
        .filter(({ day }) => !isDayPast(day, weekId))
        .map(({ day, date }) => {
            const label = `${capitalize(day)} ${date}${getOrdinal(date)}`;
            return { label, value: day };
        });

    // Discord requires at least 1 option — if all days are past, show a placeholder
    if (options.length === 0) {
        options.push({ label: 'No days remaining', value: '_none' });
    }

    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder('Edit day...')
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(options);
}

async function replyNotLinked(interaction: ButtonInteraction | StringSelectMenuInteraction, teamId: string): Promise<void> {
    const db = getDb();
    const snap = await db.collection('users')
        .where('discordUserId', '==', interaction.user.id)
        .limit(1)
        .get();

    if (snap.empty) {
        await interaction.reply({
            content: 'Link your Discord account at **matchscheduler.web.app** first.',
            flags: MessageFlags.Ephemeral,
        });
    } else {
        const teamDoc = await db.collection('teams').doc(teamId).get();
        const teamName = teamDoc.exists ? teamDoc.data()?.teamName : teamId;
        await interaction.reply({
            content: `You're not a member of **${teamName}** on MatchScheduler.`,
            flags: MessageFlags.Ephemeral,
        });
    }
}
