/**
 * Embed builder for the persistent schedule message.
 *
 * Builds a minimal embed with clickable match links shown below the grid image.
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
 * Build a minimal embed with clickable H2H links below the match card images.
 * The canvas cards handle the visual — this just provides clickable links.
 */
export function buildMatchLinksEmbed(
    teamId: string,
    matches: Array<{ opponentTag: string; opponentId: string }>,
): EmbedBuilder {
    const lines = matches.map(m => {
        const url = `${SCHEDULER_BASE}/#/teams/${teamId}/h2h/${m.opponentId}`;
        return `[vs ${m.opponentTag} \u2014 H2H Stats](${url})`;
    });

    return new EmbedBuilder()
        .setDescription(lines.join('\n'))
        .setColor(0x8b7cf0);
}

/**
 * Build a minimal embed linking to proposals on the scheduler site.
 */
export function buildProposalLinksEmbed(teamId: string): EmbedBuilder {
    const url = `${SCHEDULER_BASE}/#/teams/${teamId}`;
    return new EmbedBuilder()
        .setDescription(`[View proposals on scheduler.quake.world](${url})`)
        .setColor(0x4a4d6a);
}
