/**
 * Embed builder for the persistent schedule message.
 *
 * Builds per-card embeds with setImage() for pairing each card's
 * canvas image with its clickable link in Discord.
 */

import { EmbedBuilder } from 'discord.js';
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
 * Build a per-match embed with its card image and H2H link.
 * The `attachmentName` is set via setImage('attachment://...') to pair
 * this embed with its card PNG in the same message.
 */
export function buildMatchEmbed(
    teamId: string,
    match: { opponentTag: string; opponentId: string },
    attachmentName: string,
    color: number,
): EmbedBuilder {
    const url = `${SCHEDULER_BASE}/#/teams/${teamId}/h2h/${match.opponentId}`;
    return new EmbedBuilder()
        .setImage(`attachment://${attachmentName}`)
        .setDescription(`[vs ${match.opponentTag} \u2014 H2H Stats](${url})`)
        .setColor(color);
}

/**
 * Build a per-proposal embed with its card image and scheduler link.
 */
export function buildProposalEmbed(
    teamId: string,
    opponentTag: string,
    attachmentName: string,
): EmbedBuilder {
    const url = `${SCHEDULER_BASE}/#/teams/${teamId}`;
    return new EmbedBuilder()
        .setImage(`attachment://${attachmentName}`)
        .setDescription(`[vs ${opponentTag} \u2014 View on scheduler](${url})`)
        .setColor(0x4a4d6a);
}
