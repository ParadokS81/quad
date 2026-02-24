/**
 * Interaction handlers for the persistent schedule message.
 *
 * Handles:
 * - avail:editDay:{teamId}            — Day select on current week grid
 * - avail:editDay:{teamId}:next       — Day select on next week grid
 * - avail:toggleSlot:{teamId}:{cetDay}:{weekId}:{cetTime} — Toggle a time slot button
 * - avail:saveSlots:{teamId}:{cetDay}:{weekId}            — Save toggled slots to Firestore
 */

import {
    type ButtonInteraction,
    type StringSelectMenuInteraction,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ActionRowBuilder,
    MessageFlags,
    ComponentType,
} from 'discord.js';
import { FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { getDb } from '../standin/firestore.js';
import { resolveUser } from './user-resolver.js';
import {
    getCurrentWeekId,
    getNextWeekId,
    getWeekDates,
    cetToUtcSlotId,
    isDayPast,
    isSlotPast,
    formatCetTime,
    CET_SLOT_TIMES,
    getAdjacentDay,
} from './time.js';
import { getAvailabilityForWeek } from './listener.js';

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
    } else if (customId.startsWith('avail:toggleSlot:')) {
        await handleSlotToggle(interaction);
    } else if (customId.startsWith('avail:saveSlots:')) {
        await handleSaveSlots(interaction);
    } else if (customId.startsWith('avail:prevDay:')) {
        await handleNavDay(interaction, 'prev');
    } else if (customId.startsWith('avail:nextDay:')) {
        await handleNavDay(interaction, 'next');
    } else if (customId.startsWith('avail:saveTemplate:')) {
        await handleSaveTemplate(interaction);
    } else if (customId.startsWith('avail:options:')) {
        await handleOptions(interaction);
    } else if (customId.startsWith('avail:toggleRecurring:')) {
        await handleToggleRecurring(interaction);
    } else if (customId.startsWith('avail:clearTemplate:')) {
        await handleClearTemplate(interaction);
    } else {
        await interaction.reply({ content: 'Unknown button.', flags: MessageFlags.Ephemeral });
    }
}

export async function handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const customId = interaction.customId;

    if (customId.startsWith('avail:editDay:')) {
        await handleDaySelect(interaction);
    } else {
        await interaction.reply({ content: 'Unknown menu.', flags: MessageFlags.Ephemeral });
    }
}

// ── Edit Day Flow ───────────────────────────────────────────────────────────

/**
 * Step 1: User selects a day from the persistent message dropdown.
 * Shows an ephemeral with toggle buttons for each time slot.
 *
 * CustomId format:
 * - avail:editDay:{teamId}       — current week
 * - avail:editDay:{teamId}:next  — next week
 */
async function handleDaySelect(interaction: StringSelectMenuInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const isNextWeek = parts[3] === 'next';
    const cetDay = interaction.values[0];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const weekId = isNextWeek ? getNextWeekId() : getCurrentWeekId();

    if (!isNextWeek && isDayPast(cetDay, weekId)) {
        await interaction.editReply({ content: 'This day has already passed.' });
        return;
    }

    const currentSlots = getUserSlotsForWeek(teamId, user.uid, cetDay, weekId);

    // Filter out past time slots for current week, show all for next week
    const visibleSlots = CET_SLOT_TIMES
        .filter(time => isNextWeek || !isSlotPast(cetToUtcSlotId(cetDay, time), weekId));

    if (visibleSlots.length === 0) {
        await interaction.editReply({ content: 'All time slots for this day have passed.' });
        return;
    }

    const components = buildSlotButtonGrid(visibleSlots, currentSlots, teamId, cetDay, weekId);

    const dayLabel = formatDayLabel(cetDay, weekId);
    const weekLabel = isNextWeek ? ' (next week)' : '';

    await interaction.editReply({
        content: `**${dayLabel}${weekLabel}**\nTap to toggle your availability, then save:`,
        components,
    });
}

/**
 * Step 2: User taps a time slot button to toggle it.
 * Flips the button style (green ↔ gray) without writing to Firestore.
 */
async function handleSlotToggle(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();

    const clickedId = interaction.customId;

    // Rebuild components from the current message, flipping the clicked button
    const rows = interaction.message.components
        .filter(row => row.type === ComponentType.ActionRow)
        .map(row => {
            const newRow = new ActionRowBuilder<ButtonBuilder>();
            for (const component of row.components) {
                if (component.type !== ComponentType.Button) continue;
                const btn = ButtonBuilder.from(component);
                if (component.customId === clickedId) {
                    // Toggle: Success ↔ Secondary
                    btn.setStyle(
                        component.style === ButtonStyle.Success
                            ? ButtonStyle.Secondary
                            : ButtonStyle.Success,
                    );
                }
                newRow.addComponents(btn);
            }
            return newRow;
        });

    await interaction.editReply({ components: rows });
}

/**
 * Step 3: User clicks Save. Reads button states from the message,
 * diffs against Firestore, and commits changes.
 */
async function handleSaveSlots(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();

    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const cetDay = parts[3];
    const weekId = parts[4] ?? getCurrentWeekId();

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    // Read selected slots from button styles
    const selectedCetTimes: string[] = [];
    for (const row of interaction.message.components.filter(r => r.type === ComponentType.ActionRow)) {
        for (const component of row.components) {
            if (component.type !== ComponentType.Button) continue;
            if (!component.customId?.startsWith('avail:toggleSlot:')) continue;
            if (component.style === ButtonStyle.Success) {
                // Extract cetTime from: avail:toggleSlot:{teamId}:{cetDay}:{weekId}:{cetTime}
                const cetTime = component.customId.split(':')[5];
                if (cetTime) selectedCetTimes.push(cetTime);
            }
        }
    }

    const currentSlots = getUserSlotsForWeek(teamId, user.uid, cetDay, weekId);

    const toAdd = selectedCetTimes.filter(t => !currentSlots.includes(t));
    const toRemove = currentSlots.filter(t => !selectedCetTimes.includes(t));

    if (toAdd.length === 0 && toRemove.length === 0) {
        await interaction.editReply({ content: 'No changes made.', components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
        return;
    }

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
        await interaction.editReply({ content: 'Failed to update — try again.', components: [] });
        return;
    }

    const addedStr = toAdd.map(t => formatCetTime(t)).join(', ');
    const removedStr = toRemove.map(t => formatCetTime(t)).join(', ');
    let summary = `**${DAY_NAMES[cetDay] ?? capitalize(cetDay)}** updated`;
    if (addedStr) summary += `\nAdded: ${addedStr}`;
    if (removedStr) summary += `\nRemoved: ${removedStr}`;

    await interaction.editReply({ content: summary, components: [] });

    setTimeout(() => {
        interaction.deleteReply().catch(() => {});
    }, 5000);

    logger.info('Availability updated via Discord', {
        teamId, userId: user.uid, cetDay, weekId, added: toAdd.length, removed: toRemove.length,
    });
}

/**
 * Handle Prev/Next navigation: save current day, show adjacent day's buttons.
 * Custom ID format: avail:prevDay:{teamId}:{cetDay}:{weekId} (or avail:nextDay:...)
 */
async function handleNavDay(interaction: ButtonInteraction, direction: 'prev' | 'next'): Promise<void> {
    await interaction.deferUpdate();

    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const cetDay = parts[3];
    const weekId = parts[4] ?? getCurrentWeekId();
    const isNextWeek = weekId !== getCurrentWeekId();

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    // ── Save current day (same logic as handleSaveSlots) ──
    const selectedCetTimes: string[] = [];
    for (const row of interaction.message.components.filter(r => r.type === ComponentType.ActionRow)) {
        for (const component of row.components) {
            if (component.type !== ComponentType.Button) continue;
            if (!component.customId?.startsWith('avail:toggleSlot:')) continue;
            if (component.style === ButtonStyle.Success) {
                const cetTime = component.customId.split(':')[5];
                if (cetTime) selectedCetTimes.push(cetTime);
            }
        }
    }

    const currentSlots = getUserSlotsForWeek(teamId, user.uid, cetDay, weekId);
    const toAdd = selectedCetTimes.filter(t => !currentSlots.includes(t));
    const toRemove = currentSlots.filter(t => !selectedCetTimes.includes(t));

    if (toAdd.length > 0 || toRemove.length > 0) {
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
            logger.error('Failed to save during nav', {
                teamId, userId: user.uid, direction,
                error: err instanceof Error ? err.message : String(err),
            });
            await interaction.editReply({ content: 'Failed to save — try again.', components: [] });
            return;
        }

        logger.info('Availability saved via nav', {
            teamId, userId: user.uid, cetDay, weekId, direction,
            added: toAdd.length, removed: toRemove.length,
        });
    }

    // ── Navigate to adjacent day ──
    const nextDay = getAdjacentDay(cetDay, direction, weekId, isNextWeek);
    if (!nextDay) {
        await interaction.editReply({ content: 'No more days in this direction.', components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
        return;
    }

    const newSlots = getUserSlotsForWeek(teamId, user.uid, nextDay, weekId);
    const visibleSlots = CET_SLOT_TIMES
        .filter(time => isNextWeek || !isSlotPast(cetToUtcSlotId(nextDay, time), weekId));

    if (visibleSlots.length === 0) {
        await interaction.editReply({ content: 'All time slots for this day have passed.', components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 3000);
        return;
    }

    const components = buildSlotButtonGrid(visibleSlots, newSlots, teamId, nextDay, weekId);
    const dayLabel = formatDayLabel(nextDay, weekId);
    const weekLabel = isNextWeek ? ' (next week)' : '';

    await interaction.editReply({
        content: `**${dayLabel}${weekLabel}**\nTap to toggle your availability, then save:`,
        components,
    });
}

// ── Button Grid Builder ─────────────────────────────────────────────────────

/**
 * Build the toggle button grid for time slot selection.
 * Green (Success) = available, Gray (Secondary) = not available.
 * Last row has a Save button.
 */
function buildSlotButtonGrid(
    visibleSlots: string[],
    currentSlots: string[],
    teamId: string,
    cetDay: string,
    weekId: string,
): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    let currentRow = new ActionRowBuilder<ButtonBuilder>();

    for (let i = 0; i < visibleSlots.length; i++) {
        const cetTime = visibleSlots[i];
        const isAvailable = currentSlots.includes(cetTime);

        const button = new ButtonBuilder()
            .setCustomId(`avail:toggleSlot:${teamId}:${cetDay}:${weekId}:${cetTime}`)
            .setLabel(formatCetTime(cetTime))
            .setStyle(isAvailable ? ButtonStyle.Success : ButtonStyle.Secondary);

        currentRow.addComponents(button);

        // 5 buttons per row
        if (currentRow.components.length === 5 || i === visibleSlots.length - 1) {
            rows.push(currentRow);
            currentRow = new ActionRowBuilder<ButtonBuilder>();
        }
    }

    // Navigation row: [◀ Prev] [Save] [Next ▶]
    const isNextWeek = weekId !== getCurrentWeekId();
    const prevDay = getAdjacentDay(cetDay, 'prev', weekId, isNextWeek);
    const nextDay = getAdjacentDay(cetDay, 'next', weekId, isNextWeek);

    const navRow = new ActionRowBuilder<ButtonBuilder>();

    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`avail:prevDay:${teamId}:${cetDay}:${weekId}`)
            .setLabel('◀ Prev')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!prevDay),
    );

    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`avail:saveSlots:${teamId}:${cetDay}:${weekId}`)
            .setLabel('Save')
            .setStyle(ButtonStyle.Primary),
    );

    navRow.addComponents(
        new ButtonBuilder()
            .setCustomId(`avail:nextDay:${teamId}:${cetDay}:${weekId}`)
            .setLabel('Next ▶')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(!nextDay),
    );

    rows.push(navRow);

    return rows;
}

// ── Clear Week Flow ─────────────────────────────────────────────────────────

async function handleClearWeek(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const isNextWeek = parts[3] === 'next';

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const weekId = isNextWeek ? getNextWeekId() : getCurrentWeekId();
    const docId = `${teamId}_${weekId}`;
    const db = getDb();
    const docRef = db.collection('availability').doc(docId);
    const doc = await docRef.get();

    if (!doc.exists) {
        await interaction.editReply({
            content: `You have no availability set for ${isNextWeek ? 'next' : 'this'} week.`,
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
        await interaction.editReply({
            content: `You have no availability set for ${isNextWeek ? 'next' : 'this'} week.`,
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
        await interaction.editReply({
            content: 'Failed to clear — try again.',
        });
        return;
    }

    const weekNum = weekId.split('-')[1];
    await interaction.editReply({
        content: `Cleared all your availability for Week ${weekNum}.`,
    });

    logger.info('Availability cleared via Discord', { teamId, userId: user.uid, weekId });
}

// ── Template Actions ─────────────────────────────────────────────────────────

/**
 * Save current week's availability as the user's template.
 * Custom ID: avail:saveTemplate:{teamId}:{weekId|'current'}
 */
async function handleSaveTemplate(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts = interaction.customId.split(':');
    const teamId = parts[2];
    const weekParam = parts[3];
    const weekId = weekParam === 'current' ? getCurrentWeekId() : weekParam;

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const availability = getAvailabilityForWeek(teamId, weekId);
    if (!availability) {
        await interaction.editReply({ content: 'Mark some availability first, then save as template.' });
        return;
    }

    const userSlots: string[] = [];
    for (const [slotId, users] of Object.entries(availability.slots || {})) {
        if ((users as string[]).includes(user.uid)) {
            userSlots.push(slotId);
        }
    }

    if (userSlots.length === 0) {
        await interaction.editReply({ content: 'Mark some availability first, then save as template.' });
        return;
    }

    const db = getDb();
    const userRef = db.collection('users').doc(user.uid);
    const userDoc = await userRef.get();
    const existing = userDoc.data()?.template || {};

    await userRef.update({
        template: {
            slots: userSlots,
            recurring: existing.recurring || false,
            lastAppliedWeekId: existing.lastAppliedWeekId || '',
            updatedAt: FieldValue.serverTimestamp(),
        },
    });

    await interaction.editReply({
        content: `✓ Template saved (${userSlots.length} slots from this week)`,
    });

    logger.info('Template saved via Discord', { teamId, userId: user.uid, slotCount: userSlots.length });
}

/**
 * Show template options as an ephemeral message.
 * Custom ID: avail:options:{teamId}
 */
async function handleOptions(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const parts = interaction.customId.split(':');
    const teamId = parts[2];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const db = getDb();
    const userDoc = await db.collection('users').doc(user.uid).get();
    const template = userDoc.data()?.template;

    if (!template || !template.slots || template.slots.length === 0) {
        await interaction.editReply({
            content: 'No template saved. Use **Save Template** to save your current week.',
        });
        return;
    }

    const recurring = template.recurring || false;

    const components = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`avail:toggleRecurring:${teamId}`)
                .setLabel(recurring ? '✓ Recurring ON — Turn Off' : 'Turn On Recurring')
                .setStyle(recurring ? ButtonStyle.Success : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`avail:clearTemplate:${teamId}`)
                .setLabel('Clear Template')
                .setStyle(ButtonStyle.Danger),
        ),
    ];

    await interaction.editReply({
        content: `**Your template:** ${template.slots.length} slots\n**Recurring:** ${recurring ? 'ON' : 'OFF'}`,
        components,
    });
}

/**
 * Toggle recurring on the user's template.
 * Custom ID: avail:toggleRecurring:{teamId}
 */
async function handleToggleRecurring(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();

    const parts = interaction.customId.split(':');
    const teamId = parts[2];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const db = getDb();
    const userDoc = await db.collection('users').doc(user.uid).get();
    const template = userDoc.data()?.template;

    if (!template || !template.slots || template.slots.length === 0) {
        await interaction.editReply({
            content: 'No template saved.',
            components: [],
        });
        return;
    }

    const newRecurring = !template.recurring;

    if (newRecurring) {
        const teams = userDoc.data()?.teams || {};
        const currentWeekId = getCurrentWeekId();
        const nextWeekId = getNextWeekId();

        try {
            for (const tid of Object.keys(teams)) {
                await applyTemplateToWeek(db, user.uid, template.slots, tid, currentWeekId);
                await applyTemplateToWeek(db, user.uid, template.slots, tid, nextWeekId);
            }
        } catch (err) {
            logger.error('Failed to apply template on recurring toggle', {
                userId: user.uid, error: err instanceof Error ? err.message : String(err),
            });
            await interaction.editReply({ content: 'Failed to apply template — try again.', components: [] });
            return;
        }

        await db.collection('users').doc(user.uid).update({
            'template.recurring': true,
            'template.lastAppliedWeekId': nextWeekId,
            'template.updatedAt': FieldValue.serverTimestamp(),
        });

        await interaction.editReply({
            content: `**Your template:** ${template.slots.length} slots\n**Recurring:** ON ✓\n\nApplied to current + next week.`,
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`avail:toggleRecurring:${teamId}`)
                        .setLabel('✓ Recurring ON — Turn Off')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`avail:clearTemplate:${teamId}`)
                        .setLabel('Clear Template')
                        .setStyle(ButtonStyle.Danger),
                ),
            ],
        });
    } else {
        await db.collection('users').doc(user.uid).update({
            'template.recurring': false,
            'template.updatedAt': FieldValue.serverTimestamp(),
        });

        await interaction.editReply({
            content: `**Your template:** ${template.slots.length} slots\n**Recurring:** OFF`,
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`avail:toggleRecurring:${teamId}`)
                        .setLabel('Turn On Recurring')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`avail:clearTemplate:${teamId}`)
                        .setLabel('Clear Template')
                        .setStyle(ButtonStyle.Danger),
                ),
            ],
        });
    }

    logger.info('Recurring toggled via Discord', { teamId, userId: user.uid, recurring: newRecurring });
}

/**
 * Clear the user's template.
 * Custom ID: avail:clearTemplate:{teamId}
 */
async function handleClearTemplate(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();

    const parts = interaction.customId.split(':');
    const teamId = parts[2];

    const user = await resolveUser(interaction.user.id, teamId);
    if (!user) return replyNotLinked(interaction, teamId);

    const db = getDb();
    await db.collection('users').doc(user.uid).update({
        template: FieldValue.delete(),
    });

    await interaction.editReply({
        content: 'Template cleared.',
        components: [],
    });

    logger.info('Template cleared via Discord', { teamId, userId: user.uid });
}

/**
 * Apply template slots to a team's week availability.
 * Skips if the user already has any slots in that week.
 */
async function applyTemplateToWeek(
    db: FirebaseFirestore.Firestore,
    userId: string,
    templateSlots: string[],
    teamId: string,
    weekId: string,
): Promise<void> {
    const docId = `${teamId}_${weekId}`;
    const docRef = db.collection('availability').doc(docId);
    const doc = await docRef.get();

    if (doc.exists) {
        const slots = doc.data()?.slots || {};
        for (const users of Object.values(slots)) {
            if (Array.isArray(users) && users.includes(userId)) {
                return; // Already has availability — don't overwrite
            }
        }
    }

    const updateData: Record<string, any> = {
        lastUpdated: FieldValue.serverTimestamp(),
    };

    for (const slotId of templateSlots) {
        updateData[`slots.${slotId}`] = FieldValue.arrayUnion(userId);
        updateData[`unavailable.${slotId}`] = FieldValue.arrayRemove(userId);
    }

    if (doc.exists) {
        await docRef.update(updateData);
    } else {
        await docRef.set({ teamId, weekId, slots: {}, unavailable: {}, ...updateData });
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Get CET time slots the user is available for on a given day+week.
 * Reads from the cached listener state — no extra Firestore read.
 */
function getUserSlotsForWeek(teamId: string, uid: string, cetDay: string, weekId: string): string[] {
    const availability = getAvailabilityForWeek(teamId, weekId);
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
 * Used on the persistent message.
 */
export function buildDaySelectMenu(customId: string, weekId?: string): StringSelectMenuBuilder {
    const wId = weekId ?? getCurrentWeekId();
    const weekDates = getWeekDates(wId);
    const isNextWeek = weekId !== undefined && weekId !== getCurrentWeekId();

    const options = weekDates
        .filter(({ day }) => isNextWeek || !isDayPast(day, wId))
        .map(({ day, date }) => {
            const label = `${capitalize(day)} ${date}${getOrdinal(date)}`;
            return { label, value: day };
        });

    if (options.length === 0) {
        options.push({ label: 'No days remaining', value: '_none' });
    }

    return new StringSelectMenuBuilder()
        .setCustomId(customId)
        .setPlaceholder(isNextWeek ? 'Edit day (next week)...' : 'Edit day...')
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
        await interaction.editReply({
            content: 'Link your Discord account at **matchscheduler.web.app** first.',
        });
    } else {
        const teamDoc = await db.collection('teams').doc(teamId).get();
        const teamName = teamDoc.exists ? teamDoc.data()?.teamName : teamId;
        await interaction.editReply({
            content: `You're not a member of **${teamName}** on MatchScheduler.`,
        });
    }
}
