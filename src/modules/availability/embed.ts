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

    // "TONIGHT 21:30" when match is today (CET)
    const now = new Date();
    const cetNow = new Date(now.getTime() + 1 * 3600_000); // UTC+1
    const slotFullDate = cetDay !== utcDay
        ? new Date(dateInfo.fullDate.getTime() + 86400_000)
        : dateInfo.fullDate;
    if (slotFullDate.getUTCDate() === cetNow.getUTCDate()
        && slotFullDate.getUTCMonth() === cetNow.getUTCMonth()
        && slotFullDate.getUTCFullYear() === cetNow.getUTCFullYear()) {
        return `TONIGHT ${cetTime}`;
    }

    return `${DAY_LABELS[cetDay] ?? cetDay} ${dateInfo.date}${getOrdinal(dateInfo.date)} ${cetTime} CET`;
}

const SCHEDULER_BASE = 'https://scheduler.quake.world';

/**
 * Build a single action row with an H2H link button for one match.
 * One button per message — paired directly with its card image.
 */
export function buildMatchButton(
    teamId: string,
    match: { opponentTag: string; opponentId: string },
): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setLabel('Head2Head stats')
        .setURL(`${SCHEDULER_BASE}/#/teams/${teamId}/h2h/${match.opponentId}`)
        .setStyle(ButtonStyle.Link);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}

/**
 * Build a single action row with a proposal link button.
 * One button per message — paired directly with its card image.
 */
export function buildProposalButton(
    proposal: { proposalId: string; opponentTag: string },
): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
        .setLabel('View proposal')
        .setURL(`${SCHEDULER_BASE}/#/matches/${proposal.proposalId}`)
        .setStyle(ButtonStyle.Link);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
}
