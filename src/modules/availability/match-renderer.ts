/**
 * Canvas renderer for match and proposal cards.
 *
 * Each card is an individual 550px-wide PNG — one per Discord message,
 * paired with its own link button directly below it.
 *
 * Match card:    550 × 75px — [ownLogo] OFFICIAL   vs   OpponentName [oppLogo]   date
 *                              "vs" is fixed at horizontal center so logos align vertically
 * Proposal card: 550 × 56px — [oppLogo] vs Full Name  ·  N viable slots
 */

import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
// Importing from renderer.ts ensures fonts are registered (module side-effect)
import { COLORS, FONT } from './renderer.js';

// ── Card dimensions ──────────────────────────────────────────────────────────

const W = 550;
const MATCH_H = 75;
const PROPOSAL_H = 56;
const LOGO_SIZE = 42;           // match card logo diameter
const LOGO_SIZE_SM = 34;        // proposal card logo diameter
const CARD_RADIUS = 6;          // corner radius

// ── Colors ──────────────────────────────────────────────────────────────────

const COLOR_OFFICIAL = '#22c55e';
const COLOR_PRACTICE = '#f59e0b';
const LOGO_FALLBACK_BG = '#4a4d6a';
const PROPOSAL_BG = '#2a2c40';

// ── Match card ──────────────────────────────────────────────────────────────

export interface MatchCardInput {
    ownTag: string;              // for logo fallback initials
    ownLogo: Image | null;
    opponentName: string;        // full clan name for display
    opponentTag: string;         // for logo fallback initials
    opponentLogo: Image | null;
    gameType: 'official' | 'practice';
    scheduledDate: string;       // e.g. "Sun 22nd 21:30 CET"
}

/**
 * Render a single match card as a standalone PNG.
 *
 * Layout — "vs" fixed at horizontal center, logos align vertically across cards:
 *   [ownLogo] OFFICIAL        vs        Hell Xpress [oppLogo]  Sun 22nd 21:30 CET
 *   ═══════════════════ accent line (badge color) ════════════════════════════════
 */
export async function renderMatchCard(input: MatchCardInput): Promise<Buffer> {
    const canvas = createCanvas(W, MATCH_H);
    const ctx = canvas.getContext('2d');

    drawRoundedRect(ctx, 0, 0, W, MATCH_H, CARD_RADIUS, COLORS.cellEmpty);

    const badgeColor = input.gameType === 'official' ? COLOR_OFFICIAL : COLOR_PRACTICE;
    const badgeText = input.gameType === 'official' ? 'OFFICIAL' : 'PRACTICE';
    const centerY = (MATCH_H - 2) / 2;
    const centerX = W / 2;

    const pad = 14;
    const logoGap = 10;

    // ── "vs" at dead center ──
    ctx.font = `15px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('vs', centerX, centerY);

    // ── Left side: [ownLogo] BADGE — left-aligned ──
    const leftX = pad;
    drawLogo(ctx, input.ownLogo, input.ownTag, leftX + LOGO_SIZE / 2, centerY, LOGO_SIZE);

    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = badgeColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, leftX + LOGO_SIZE + logoGap, centerY);

    // ── Right side: OpponentName [oppLogo] — starts right of "vs" ──
    const vsHalfW = ctx.measureText('vs').width / 2 + 2; // measure with vs font
    ctx.font = `15px ${FONT}`;  // reset to vs font for measurement
    const rightStart = centerX + 20; // fixed gap right of "vs"

    ctx.font = `bold 16px ${FONT}`;
    ctx.fillStyle = COLORS.textPrimary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';

    // Budget for opponent name: from rightStart to before oppLogo + date
    const dateFont = `13px ${FONT}`;
    ctx.font = dateFont;
    const dateW = ctx.measureText(input.scheduledDate).width;
    ctx.font = `bold 16px ${FONT}`;

    const maxNameW = W - rightStart - logoGap - LOGO_SIZE - logoGap - dateW - pad;
    const oppName = truncateText(ctx, input.opponentName, maxNameW);
    ctx.fillText(oppName, rightStart, centerY);

    const nameW = ctx.measureText(oppName).width;
    const oppLogoX = rightStart + nameW + logoGap + LOGO_SIZE / 2;
    drawLogo(ctx, input.opponentLogo, input.opponentTag, oppLogoX, centerY, LOGO_SIZE);

    // ── Date — right-aligned ──
    ctx.font = dateFont;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.scheduledDate, W - pad, centerY);

    // Bottom accent line
    ctx.fillStyle = badgeColor;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, MATCH_H - 2, W, 2);
    ctx.globalAlpha = 1.0;

    return canvas.toBuffer('image/png');
}

// ── Proposal card ───────────────────────────────────────────────────────────

export interface ProposalCardInput {
    opponentName: string;        // full clan name
    opponentTag: string;         // for logo fallback initials
    opponentLogo: Image | null;
    viableSlots: number;
}

/**
 * Render a single proposal card as a standalone PNG.
 */
export async function renderProposalCard(input: ProposalCardInput): Promise<Buffer> {
    const canvas = createCanvas(W, PROPOSAL_H);
    const ctx = canvas.getContext('2d');

    drawRoundedRect(ctx, 0, 0, W, PROPOSAL_H, CARD_RADIUS, PROPOSAL_BG);

    const centerY = PROPOSAL_H / 2;
    const pad = 14;
    let x = pad;

    // Opponent logo
    drawLogo(ctx, input.opponentLogo, input.opponentTag, x + LOGO_SIZE_SM / 2, centerY, LOGO_SIZE_SM);
    x += LOGO_SIZE_SM + 10;

    // "vs OpponentName"
    ctx.font = `bold 15px ${FONT}`;
    ctx.fillStyle = COLORS.textPrimary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`vs ${input.opponentName}`, x, centerY);
    x += ctx.measureText(`vs ${input.opponentName}`).width;

    // Separator dot + viable slots
    const slotsText = input.viableSlots === 1 ? '1 viable slot' : `${input.viableSlots} viable slots`;
    ctx.font = `14px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.fillText(`  \u00b7  ${slotsText}`, x, centerY);

    // Subtle left accent bar
    ctx.fillStyle = COLORS.todayHighlight;
    ctx.globalAlpha = 0.4;
    ctx.fillRect(0, 0, 3, PROPOSAL_H);
    ctx.globalAlpha = 1.0;

    return canvas.toBuffer('image/png');
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

/** Truncate text with ellipsis if it exceeds maxWidth. */
function truncateText(ctx: SKRSContext2D, text: string, maxWidth: number): string {
    if (maxWidth <= 0) return text;
    if (ctx.measureText(text).width <= maxWidth) return text;
    let truncated = text;
    while (truncated.length > 0 && ctx.measureText(truncated + '\u2026').width > maxWidth) {
        truncated = truncated.slice(0, -1);
    }
    return truncated + '\u2026';
}

/** Draw a circular logo or a fallback circle with initials. */
function drawLogo(
    ctx: SKRSContext2D,
    logo: Image | null,
    tag: string,
    cx: number,
    cy: number,
    size: number,
): void {
    const r = size / 2;

    if (logo) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(logo, cx - r, cy - r, size, size);
        ctx.restore();
    } else {
        ctx.fillStyle = LOGO_FALLBACK_BG;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.fill();

        const initials = tag.replace(/[\[\]<>{}()|]/g, '').slice(0, 2).toUpperCase();
        ctx.fillStyle = COLORS.textPrimary;
        ctx.font = `bold ${Math.round(size * 0.38)}px ${FONT}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(initials, cx, cy);
    }
}

/** Draw a rounded rectangle filled with the given color. */
function drawRoundedRect(
    ctx: SKRSContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    radius: number,
    color: string,
): void {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fill();
}
