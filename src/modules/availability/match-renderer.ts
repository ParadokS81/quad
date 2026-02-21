/**
 * Canvas renderer for match and proposal cards.
 *
 * Renders all cards of each type into a single combined canvas (vertical stack).
 * Discord would display multiple attachments side-by-side in a gallery grid,
 * so we composite everything into one tall image to get vertical layout.
 *
 * Match card:    550 × 72px — [ownLogo] OFFICIAL vs Opponent [oppLogo] + date
 * Proposal card: 550 × 56px — [oppLogo] vs Opponent + viable slot count
 */

import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
// Importing from renderer.ts ensures fonts are registered (module side-effect)
import { COLORS, FONT } from './renderer.js';

// ── Card dimensions ──────────────────────────────────────────────────────────

const W = 550;
const MATCH_H = 72;
const PROPOSAL_H = 56;
const CARD_GAP = 6;             // gap between stacked cards
const LOGO_SIZE = 36;           // match card logo diameter
const LOGO_SIZE_SM = 28;        // proposal card logo diameter
const CARD_RADIUS = 6;          // corner radius

// ── Colors ──────────────────────────────────────────────────────────────────

const BADGE_OFFICIAL = '#22c55e';
const BADGE_PRACTICE = '#f59e0b';
const LOGO_FALLBACK_BG = '#4a4d6a';
const PROPOSAL_BG = '#2a2c40';

// ── Match cards (combined) ──────────────────────────────────────────────────

export interface MatchCardInput {
    ownTag: string;
    ownLogo: Image | null;
    opponentTag: string;
    opponentLogo: Image | null;
    gameType: 'official' | 'practice';
    scheduledDate: string;       // e.g. "Sun 22nd 21:30 CET"
}

/**
 * Render all match cards into a single combined PNG.
 * Cards are stacked vertically with a small gap between them.
 */
export async function renderMatchesImage(cards: MatchCardInput[]): Promise<Buffer> {
    if (cards.length === 0) return Buffer.alloc(0);

    const totalH = cards.length * MATCH_H + (cards.length - 1) * CARD_GAP;
    const canvas = createCanvas(W, totalH);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < cards.length; i++) {
        const y = i * (MATCH_H + CARD_GAP);
        drawMatchCard(ctx, y, cards[i]!);
    }

    return canvas.toBuffer('image/png');
}

/**
 * Draw a single match card at the given Y offset.
 *
 * Layout:
 *   Row 1 (centered): [ownLogo] OFFICIAL vs OpponentName [opponentLogo]
 *   Row 2 (centered): Sun 22nd 21:30 CET
 *   Bottom: accent line in badge color
 */
function drawMatchCard(ctx: SKRSContext2D, y: number, input: MatchCardInput): void {
    // Background
    drawRoundedRect(ctx, 0, y, W, MATCH_H, CARD_RADIUS, COLORS.cellEmpty);

    const badgeColor = input.gameType === 'official' ? BADGE_OFFICIAL : BADGE_PRACTICE;
    const badgeText = input.gameType === 'official' ? 'OFFICIAL' : 'PRACTICE';

    // ── Row 1: [ownLogo]  OFFICIAL vs OpponentName  [oppLogo] ──
    const row1Y = y + 26;
    const logoGap = 10;

    // Measure text segments to center the whole group
    ctx.font = `bold 11px ${FONT}`;
    const badgeW = ctx.measureText(badgeText).width;

    ctx.font = `12px ${FONT}`;
    const vsW = ctx.measureText(' vs ').width;

    ctx.font = `bold 14px ${FONT}`;
    const oppNameW = ctx.measureText(input.opponentTag).width;

    const textBlockW = badgeW + vsW + oppNameW;
    const totalGroupW = LOGO_SIZE + logoGap + textBlockW + logoGap + LOGO_SIZE;
    const startX = (W - totalGroupW) / 2;

    // Own team logo (left)
    drawLogo(ctx, input.ownLogo, input.ownTag, startX + LOGO_SIZE / 2, row1Y, LOGO_SIZE);

    // Text segments (after own logo)
    let textX = startX + LOGO_SIZE + logoGap;

    // Badge text (OFFICIAL / PRACTICE) in badge color
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillStyle = badgeColor;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(badgeText, textX, row1Y);
    textX += badgeW;

    // " vs " in secondary color
    ctx.font = `12px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.fillText(' vs ', textX, row1Y);
    textX += vsW;

    // Opponent name in primary color
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = COLORS.textPrimary;
    ctx.fillText(input.opponentTag, textX, row1Y);

    // Opponent logo (right of text)
    const oppLogoX = startX + LOGO_SIZE + logoGap + textBlockW + logoGap + LOGO_SIZE / 2;
    drawLogo(ctx, input.opponentLogo, input.opponentTag, oppLogoX, row1Y, LOGO_SIZE);

    // ── Row 2: date/time centered ──
    const row2Y = y + 50;
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.scheduledDate, W / 2, row2Y);

    // ── Bottom accent line ──
    ctx.fillStyle = badgeColor;
    ctx.globalAlpha = 0.5;
    ctx.fillRect(0, y + MATCH_H - 2, W, 2);
    ctx.globalAlpha = 1.0;
}

// ── Proposal cards (combined) ───────────────────────────────────────────────

export interface ProposalCardInput {
    opponentTag: string;
    opponentLogo: Image | null;
    viableSlots: number;
}

/**
 * Render all proposal cards into a single combined PNG.
 */
export async function renderProposalsImage(cards: ProposalCardInput[]): Promise<Buffer> {
    if (cards.length === 0) return Buffer.alloc(0);

    const totalH = cards.length * PROPOSAL_H + (cards.length - 1) * CARD_GAP;
    const canvas = createCanvas(W, totalH);
    const ctx = canvas.getContext('2d');

    for (let i = 0; i < cards.length; i++) {
        const y = i * (PROPOSAL_H + CARD_GAP);
        drawProposalCard(ctx, y, cards[i]!);
    }

    return canvas.toBuffer('image/png');
}

/**
 * Draw a single proposal card at the given Y offset.
 */
function drawProposalCard(ctx: SKRSContext2D, y: number, input: ProposalCardInput): void {
    // Background
    drawRoundedRect(ctx, 0, y, W, PROPOSAL_H, CARD_RADIUS, PROPOSAL_BG);

    const centerY = y + PROPOSAL_H / 2;

    // Opponent logo (left)
    const logoX = 16 + LOGO_SIZE_SM / 2;
    drawLogo(ctx, input.opponentLogo, input.opponentTag, logoX, centerY, LOGO_SIZE_SM);

    // "vs TAG" text
    ctx.font = `bold 13px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`vs ${input.opponentTag}`, 16 + LOGO_SIZE_SM + 10, centerY - 6);

    // Viable slots count
    const slotsText = input.viableSlots === 1 ? '1 viable slot' : `${input.viableSlots} viable slots`;
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'left';
    ctx.fillText(slotsText, 16 + LOGO_SIZE_SM + 10, centerY + 10);

    // "view on site" (far right)
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('view on site \u2192', W - 12, centerY);

    // Subtle left accent bar
    ctx.fillStyle = COLORS.todayHighlight;
    ctx.globalAlpha = 0.4;
    drawRoundedRect(ctx, 0, y, 3, PROPOSAL_H, CARD_RADIUS, COLORS.todayHighlight);
    ctx.globalAlpha = 1.0;
}

// ── Drawing helpers ──────────────────────────────────────────────────────────

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
        // Colored circle with first 2 chars of tag
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
