/**
 * Embed builder for the persistent schedule message.
 *
 * Builds the text embed shown below the canvas-rendered grid image.
 * Shows team info, upcoming matches, and active proposals.
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

export function buildScheduleEmbed(
    teamTag: string,
    weekId: string,
    scheduledMatches: Array<{ opponentTag: string; slotId: string; scheduledDate: string }>,
    activeProposals: Array<{ opponentTag: string; viableSlots: number }>,
): EmbedBuilder {
    const weekNum = parseInt(weekId.split('-')[1] ?? '0', 10);
    const weekDates = getWeekDates(weekId);
    const first = weekDates[0];
    const last = weekDates[6];

    const dateRange = first && last
        ? (first.month === last.month
            ? `${first.month} ${first.date}\u2013${last.date}`
            : `${first.month} ${first.date} \u2013 ${last.month} ${last.date}`)
        : '';

    const lines: string[] = [];
    lines.push(`**${teamTag}** \u00b7 Week ${weekNum} \u00b7 ${dateRange}`);

    if (scheduledMatches.length > 0) {
        lines.push('');
        lines.push('\ud83d\udccb **MATCHES**');
        for (const match of scheduledMatches) {
            lines.push(`  vs ${match.opponentTag} \u2014 ${match.scheduledDate}`);
        }
    }

    if (activeProposals.length > 0) {
        lines.push('');
        lines.push('\ud83d\udce8 **PROPOSALS**');
        for (const proposal of activeProposals) {
            lines.push(`  vs ${proposal.opponentTag} \u2014 ${proposal.viableSlots} viable slot${proposal.viableSlots !== 1 ? 's' : ''}`);
        }
    }

    lines.push('');
    lines.push('Updated just now');

    return new EmbedBuilder()
        .setDescription(lines.join('\n'))
        .setColor(0x8b7cf0);
}
