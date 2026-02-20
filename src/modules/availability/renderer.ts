/**
 * Canvas renderer for the weekly availability grid.
 *
 * Produces an 800×480 PNG buffer showing team availability per day/time slot.
 * Ready to attach directly to a Discord message via AttachmentBuilder.
 */

import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { cetToUtcSlotId, isSlotPast } from './time.js';

// ── Canvas dimensions ─────────────────────────────────────────────────────────

const W = 800;
const TIME_COL_W = 60;       // left column: time labels
const HEADER_H = 35;          // top bar: team + week info
const DAY_HEADER_H = 25;      // day column headers row
const CELL_H = 40;            // height of each time-row cell
const GRID_TOP = HEADER_H + DAY_HEADER_H;   // y=60: where cells start
const LEGEND_TOP = GRID_TOP + 9 * CELL_H;   // y=420: legend area
const LEGEND_H = 24;          // legend row height

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS: Record<string, string> = {
    mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
    fri: 'Fri', sat: 'Sat', sun: 'Sun',
};

// CET 19:00–23:00 in 30-minute increments (9 slots)
const CET_SLOTS = ['1900', '1930', '2000', '2030', '2100', '2130', '2200', '2230', '2300'];

// ── Color palette (matches MatchScheduler dark theme) ────────────────────────

const COLORS = {
    background:     '#1a1b2e',
    cellEmpty:      '#2d2f45',
    cellBorder:     '#4a4d6a',
    cellMatchReady: '#4a3d8f',   // 4+ players available
    cellScheduled:  '#5b4fa0',   // has a scheduled match
    textPrimary:    '#e0e0e0',
    textSecondary:  '#9ca3af',
    todayHighlight: '#8b7cf0',   // today column header
    headerBg:       '#232440',
};

const PLAYER_COLORS = [
    '#E06666',  // Red
    '#FFD966',  // Yellow
    '#93C47D',  // Green
    '#76A5AF',  // Teal
    '#6D9EEB',  // Blue
    '#C27BA0',  // Pink
];

function getColorForUser(userId: string): string {
    let hash = 0;
    for (let i = 0; i < userId.length; i++) {
        hash = ((hash << 5) - hash) + userId.charCodeAt(i);
        hash |= 0;
    }
    return PLAYER_COLORS[Math.abs(hash) % PLAYER_COLORS.length];
}

// ── Column geometry helpers ───────────────────────────────────────────────────

/** Left edge of day column `col` (0-6), distributing rounding evenly */
function colX(col: number): number {
    return TIME_COL_W + Math.round(col * (W - TIME_COL_W) / 7);
}

/** Width of day column `col` */
function colW(col: number): number {
    return colX(col + 1) - colX(col);
}

// ── Input interface ───────────────────────────────────────────────────────────

interface RenderInput {
    teamTag: string;
    weekId: string;
    weekDates: Array<{
        day: string;
        date: number;
        month: string;
    }>;
    slots: Record<string, string[]>;
    unavailable?: Record<string, string[]>;
    roster: Record<string, {
        displayName: string;
        initials: string;
    }>;
    scheduledMatches: Array<{
        slotId: string;
        opponentTag: string;
    }>;
    now: Date;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function renderGrid(input: RenderInput): Promise<Buffer> {
    const H = LEGEND_TOP + LEGEND_H + 8;
    const canvas = createCanvas(W, H);
    const ctx = canvas.getContext('2d');

    // 1. Background
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, W, H);

    // 2. Header bar
    drawHeader(ctx, input);

    // 3. Day column headers
    drawDayHeaders(ctx, input);

    // 4. Grid border fill — cells sit inside this with 1px gaps
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = COLORS.cellBorder;
    ctx.fillRect(TIME_COL_W, GRID_TOP, W - TIME_COL_W, 9 * CELL_H);

    // 5. Time labels + cells
    for (let row = 0; row < CET_SLOTS.length; row++) {
        drawTimeLabel(ctx, row, CET_SLOTS[row]);

        for (let col = 0; col < 7; col++) {
            const cetDay = DAY_ORDER[col];
            const utcSlotId = cetToUtcSlotId(cetDay, CET_SLOTS[row]);
            const isPast = isSlotPast(utcSlotId, input.weekId);

            ctx.globalAlpha = isPast ? 0.3 : 1.0;
            drawCell(ctx, row, col, utcSlotId, input);
        }
    }
    ctx.globalAlpha = 1.0;

    // 6. Legend
    drawLegend(ctx, input, H);

    return canvas.toBuffer('image/png');
}

// ── Header ────────────────────────────────────────────────────────────────────

function drawHeader(ctx: SKRSContext2D, input: RenderInput): void {
    ctx.fillStyle = COLORS.headerBg;
    ctx.fillRect(0, 0, W, HEADER_H);

    const weekNum = parseInt(input.weekId.split('-')[1] ?? '0', 10);
    const first = input.weekDates[0];
    const last = input.weekDates[6];

    if (!first || !last) return;

    const dateRange = first.month === last.month
        ? `${first.month} ${first.date}–${last.date}`
        : `${first.month} ${first.date} – ${last.month} ${last.date}`;

    const title = `${input.teamTag}  ·  Week ${weekNum}  ·  ${dateRange}`;

    ctx.fillStyle = COLORS.textPrimary;
    ctx.font = 'bold 15px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, W / 2, HEADER_H / 2);
}

// ── Day column headers ────────────────────────────────────────────────────────

function drawDayHeaders(ctx: SKRSContext2D, input: RenderInput): void {
    ctx.fillStyle = COLORS.headerBg;
    ctx.fillRect(0, HEADER_H, W, DAY_HEADER_H);

    // "CET" label above the time column
    ctx.fillStyle = COLORS.textSecondary;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CET', TIME_COL_W / 2, HEADER_H + DAY_HEADER_H / 2);

    // Today index: 0=Mon ... 6=Sun
    const utcDay = input.now.getUTCDay();
    const todayIdx = utcDay === 0 ? 6 : utcDay - 1;

    for (let col = 0; col < 7; col++) {
        const wd = input.weekDates[col];
        if (!wd) continue;

        const label = `${DAY_LABELS[wd.day] ?? wd.day} ${wd.date}`;
        const x = colX(col);
        const w = colW(col);
        const isToday = col === todayIdx;

        ctx.fillStyle = isToday ? COLORS.todayHighlight : COLORS.textSecondary;
        ctx.font = isToday ? 'bold 12px sans-serif' : '12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x + w / 2, HEADER_H + DAY_HEADER_H / 2);
    }
}

// ── Time label ────────────────────────────────────────────────────────────────

function drawTimeLabel(ctx: SKRSContext2D, row: number, cetSlot: string): void {
    const y = GRID_TOP + row * CELL_H;
    const label = `${cetSlot.slice(0, 2)}:${cetSlot.slice(2)}`;

    // Time labels always full alpha regardless of past state
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, TIME_COL_W - 4, y + CELL_H / 2);
}

// ── Cell ──────────────────────────────────────────────────────────────────────

function drawCell(
    ctx: SKRSContext2D,
    row: number,
    col: number,
    utcSlotId: string,
    input: RenderInput,
): void {
    const x = colX(col);
    const y = GRID_TOP + row * CELL_H;
    const w = colW(col);

    const players = input.slots[utcSlotId] ?? [];
    const scheduledMatch = input.scheduledMatches.find(m => m.slotId === utcSlotId);

    // Background color
    let bgColor = COLORS.cellEmpty;
    if (scheduledMatch) bgColor = COLORS.cellScheduled;
    else if (players.length >= 4) bgColor = COLORS.cellMatchReady;

    ctx.fillStyle = bgColor;
    ctx.fillRect(x + 1, y + 1, w - 2, CELL_H - 2);

    // Scheduled match: show sword + opponent tag
    if (scheduledMatch) {
        ctx.fillStyle = COLORS.textPrimary;
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`\u2694 vs ${scheduledMatch.opponentTag}`, x + w / 2, y + CELL_H / 2);
        return;
    }

    if (players.length === 0) return;

    // Draw player initials (first character only), each in their unique color
    const MAX_SHOWN = 5;
    const toShow = players.slice(0, MAX_SHOWN);
    const hasOverflow = players.length > MAX_SHOWN;

    // Space initials evenly — use center region of cell (80%) for breathing room
    const margin = w * 0.1;
    const usableW = w - 2 * margin;
    const slotCount = hasOverflow ? MAX_SHOWN + 1 : toShow.length;
    const spacing = slotCount > 1 ? usableW / (slotCount - 1) : 0;
    const startX = slotCount > 1 ? x + margin : x + w / 2;

    ctx.font = 'bold 14px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';

    toShow.forEach((userId, i) => {
        const initial = (input.roster[userId]?.initials ?? '?')[0];
        ctx.fillStyle = getColorForUser(userId);
        ctx.fillText(initial, startX + spacing * i, y + CELL_H / 2);
    });

    if (hasOverflow) {
        ctx.fillStyle = COLORS.textSecondary;
        ctx.font = '10px sans-serif';
        ctx.fillText(`+${players.length - MAX_SHOWN}`, startX + spacing * MAX_SHOWN, y + CELL_H / 2);
    }

    // Overflow badge: only show count when 5+ players
    if (players.length >= 5) {
        ctx.fillStyle = COLORS.textPrimary;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'top';
        ctx.fillText(String(players.length), x + w - 3, y + 3);
    }
}

// ── Legend ────────────────────────────────────────────────────────────────────

function drawLegend(ctx: SKRSContext2D, input: RenderInput, canvasH: number): void {
    ctx.fillStyle = COLORS.headerBg;
    ctx.fillRect(0, LEGEND_TOP, W, canvasH - LEGEND_TOP);

    // Separator line
    ctx.fillStyle = COLORS.cellBorder;
    ctx.fillRect(0, LEGEND_TOP, W, 1);

    const entries = Object.entries(input.roster);
    if (entries.length === 0) return;

    const legendY = LEGEND_TOP + LEGEND_H / 2 + 2;
    const GAP = 24;

    const measured = entries.map(([userId, member]) => {
        ctx.font = '12px sans-serif';
        const nameW = ctx.measureText(member.displayName).width;
        ctx.font = 'bold 13px sans-serif';
        const initW = ctx.measureText(member.initials[0] ?? '?').width;
        return { userId, member, nameW, initW };
    });

    const totalW = measured.reduce((sum, m, i) =>
        sum + m.initW + 5 + m.nameW + (i < measured.length - 1 ? GAP : 0), 0);

    let x = Math.max(8, (W - totalW) / 2);

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    for (const { userId, member, nameW, initW } of measured) {
        ctx.font = 'bold 13px sans-serif';
        ctx.fillStyle = getColorForUser(userId);
        ctx.fillText(member.initials[0] ?? '?', x, legendY);
        x += initW + 5;

        ctx.font = '12px sans-serif';
        ctx.fillStyle = COLORS.textSecondary;
        ctx.fillText(member.displayName, x, legendY);
        x += nameW + GAP;
    }
}
