/**
 * Link button builders for match and proposal card messages.
 *
 * Each match/proposal gets a Discord Link Button (ButtonStyle.Link)
 * that opens the relevant page on scheduler.quake.world.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getWeekDates, utcToCet } from './time.js';

const DAY_LABELS: Record<string, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
    fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function getOrdinal(n: number): string {
    if (n >= 11 && n <= 13) return 'th';
    switch (n % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

/** Format a UTC slotId + weekId into a CET date string like "Sat 21st 21:00 CET" */
export function formatScheduledDate(slotId: string, weekId: string): string {
    const [utcDay] = slotId.split('_');
    const { day: cetDay, time: cetTime } = utcToCet(slotId);

    const dayIdx = DAY_ORDER.indexOf(utcDay ?? '');
    if (dayIdx === -1) return `${cetTime} CET`;

    const weekDates = getWeekDates(weekId);
    const dateInfo = weekDates[dayIdx];
    if (!dateInfo) return `${DAY_LABELS[cetDay] ?? cetDay} ${cetTime} CET`;

    return `${DAY_LABELS[cetDay] ?? cetDay} ${dateInfo.date}${getOrdinal(dateInfo.date)} ${cetTime} CET`;
}

const SCHEDULER_BASE = 'https://scheduler.quake.world';

/**
 * Build action rows with H2H link buttons for scheduled matches.
 * Each match gets a button: "vs OpponentTag" → H2H page.
 * Up to 5 buttons per row, up to 5 rows (25 matches max).
 */
export function buildMatchButtons(
    teamId: string,
    matches: Array<{ opponentTag: string; opponentId: string }>,
): ActionRowBuilder<ButtonBuilder>[] {
    const buttons = matches.map(m =>
        new ButtonBuilder()
            .setLabel(`H2H vs ${m.opponentTag}`)
            .setURL(`${SCHEDULER_BASE}/#/teams/${teamId}/h2h/${m.opponentId}`)
            .setStyle(ButtonStyle.Link),
    );

    return chunkIntoRows(buttons);
}

/**
 * Build action rows with proposal link buttons.
 * Each proposal gets a button: "vs OpponentTag" → proposal deep-link.
 */
export function buildProposalButtons(
    proposals: Array<{ proposalId: string; opponentTag: string }>,
): ActionRowBuilder<ButtonBuilder>[] {
    const buttons = proposals.map(p =>
        new ButtonBuilder()
            .setLabel(`vs ${p.opponentTag}`)
            .setURL(`${SCHEDULER_BASE}/#/matches/${p.proposalId}`)
            .setStyle(ButtonStyle.Link),
    );

    return chunkIntoRows(buttons);
}

/** Split buttons into action rows (max 5 buttons per row). */
function chunkIntoRows(buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder>[] {
    const rows: ActionRowBuilder<ButtonBuilder>[] = [];
    for (let i = 0; i < buttons.length; i += 5) {
        const row = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(buttons.slice(i, i + 5));
        rows.push(row);
    }
    return rows;
}
