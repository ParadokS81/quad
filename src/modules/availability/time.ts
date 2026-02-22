/**
 * CET↔UTC conversion and week utilities for the availability module.
 *
 * CET = UTC+1 (hardcoded for v1, matching the scheduler module and QW community convention).
 * The QW community universally says "CET" year-round even during summer.
 *
 * Slot IDs are stored and transmitted in UTC: "mon_1900" = Monday 19:00 UTC.
 */

const CET_OFFSET = 1;

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS: Record<string, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
    fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// CET 19:00-23:00 in 30-minute increments (9 slots per day)
export const CET_SLOT_TIMES = ['1900', '1930', '2000', '2030', '2100', '2130', '2200', '2230', '2300'];

/** Convert UTC slot ID to CET display. "mon_1900" → { day: "mon", time: "20:00" } */
export function utcToCet(utcSlotId: string): { day: string; time: string } {
    const [day, time] = utcSlotId.split('_');
    if (!time) return { day, time: '' };

    const utcHour = parseInt(time.slice(0, 2), 10);
    const min = time.slice(2);

    let cetHour = utcHour + CET_OFFSET;
    let cetDay = day;

    if (cetHour >= 24) {
        cetHour -= 24;
        const dayIdx = DAY_ORDER.indexOf(day);
        cetDay = DAY_ORDER[(dayIdx + 1) % 7];
    }

    return {
        day: cetDay,
        time: `${String(cetHour).padStart(2, '0')}:${min}`,
    };
}

/** Convert CET day+time to UTC slot ID. ("mon", "2000") → "mon_1900" */
export function cetToUtcSlotId(cetDay: string, cetTime: string): string {
    const cetHour = parseInt(cetTime.slice(0, 2), 10);
    const min = cetTime.slice(2);

    let utcHour = cetHour - CET_OFFSET;
    let utcDay = cetDay;

    if (utcHour < 0) {
        utcHour += 24;
        const dayIdx = DAY_ORDER.indexOf(cetDay);
        utcDay = DAY_ORDER[(dayIdx - 1 + 7) % 7];
    }

    return `${utcDay}_${String(utcHour).padStart(2, '0')}${min}`;
}

/** Format UTC slot ID for CET display. "mon_1900" → "Mon 20:00" */
export function formatSlotCET(utcSlotId: string): string {
    const { day, time } = utcToCet(utcSlotId);
    return `${DAY_LABELS[day] ?? day} ${time}`;
}

/** Get current ISO week ID. Returns "YYYY-WW" e.g. "2026-08" */
export function getCurrentWeekId(): string {
    return getIsoWeekId(new Date());
}

/** Get next ISO week ID. Returns "YYYY-WW" for the week after the current one. */
export function getNextWeekId(): string {
    return getIsoWeekId(new Date(Date.now() + 7 * 86400000));
}

/** Compute ISO 8601 week ID for any date. */
function getIsoWeekId(now: Date): string {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const dayNum = d.getUTCDay() || 7; // Treat Sunday as 7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // Move to Thursday
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${d.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

/** Get date objects for Mon-Sun of a given week. For day headers (e.g. "Mon 16") */
export function getWeekDates(weekId: string): Array<{ day: string; date: number; month: string; fullDate: Date }> {
    const [yearStr, weekStr] = weekId.split('-');
    const year = parseInt(yearStr, 10);
    const week = parseInt(weekStr, 10);

    // Jan 4 is always in ISO week 1
    const jan4 = new Date(Date.UTC(year, 0, 4));
    const dayOfWeek = jan4.getUTCDay() || 7; // 1=Mon ... 7=Sun
    const monday1 = new Date(jan4.getTime() - (dayOfWeek - 1) * 86400000);

    // Monday of target week
    const monday = new Date(monday1.getTime() + (week - 1) * 7 * 86400000);

    return DAY_ORDER.map((day, i) => {
        const fullDate = new Date(monday.getTime() + i * 86400000);
        return {
            day,
            date: fullDate.getUTCDate(),
            month: MONTH_LABELS[fullDate.getUTCMonth()],
            fullDate,
        };
    });
}

/** Check if a UTC slot in a given week has already passed */
export function isSlotPast(utcSlotId: string, weekId: string): boolean {
    const [day, time] = utcSlotId.split('_');
    if (!time) return false;

    const dayIdx = DAY_ORDER.indexOf(day);
    if (dayIdx === -1) return false;

    const utcHour = parseInt(time.slice(0, 2), 10);
    const utcMin = parseInt(time.slice(2), 10);

    const weekDates = getWeekDates(weekId);
    const { fullDate } = weekDates[dayIdx];

    const slotTime = new Date(Date.UTC(
        fullDate.getUTCFullYear(),
        fullDate.getUTCMonth(),
        fullDate.getUTCDate(),
        utcHour,
        utcMin,
    ));

    return slotTime.getTime() < Date.now();
}

/** Get all UTC slot IDs for a given CET day (19:00-23:00 CET = 9 slots) */
export function getSlotsForDay(cetDay: string): string[] {
    return CET_SLOT_TIMES.map(cetTime => cetToUtcSlotId(cetDay, cetTime));
}

/** Check if an entire CET day has passed (all 9 slots are past) */
export function isDayPast(cetDay: string, weekId: string): boolean {
    const lastSlot = cetToUtcSlotId(cetDay, '2300');
    return isSlotPast(lastSlot, weekId);
}

/** Format a CET time string for display. "2000" → "20:00" */
export function formatCetTime(cetTime: string): string {
    return `${cetTime.slice(0, 2)}:${cetTime.slice(2)}`;
}

/** Get remaining (non-past) days in the current week */
export function getRemainingDays(weekId: string): string[] {
    return DAY_ORDER.filter(day => {
        // A day has remaining slots if at least its last slot hasn't passed
        const lastSlot = cetToUtcSlotId(day, '2300');
        return !isSlotPast(lastSlot, weekId);
    });
}
