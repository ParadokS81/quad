/**
 * Canvas renderer for match and proposal cards.
 *
 * Each card is a standalone 550px-wide PNG. Discord stacks multiple
 * attachments vertically in a single message, giving a card-per-match layout.
 *
 * Match card:  550 × 80px — logos, team tags, "vs", game type badge, date
 * Proposal card: 550 × 60px — opponent info, viable slot count
 */

import { createCanvas, type SKRSContext2D, type Image } from '@napi-rs/canvas';
// Importing from renderer.ts ensures fonts are registered (module side-effect)
import { COLORS, FONT } from './renderer.js';

// ── Card dimensions ──────────────────────────────────────────────────────────

const W = 550;
const MATCH_H = 80;
const PROPOSAL_H = 60;
const LOGO_SIZE = 36;           // match card logo diameter
const LOGO_SIZE_SM = 28;        // proposal card logo diameter
const CARD_RADIUS = 6;          // corner radius

// ── Additional colors ────────────────────────────────────────────────────────

const BADGE_OFFICIAL = '#22c55e';
const BADGE_PRACTICE = '#f59e0b';
const LOGO_FALLBACK_BG = '#4a4d6a';
const PROPOSAL_BG = '#2a2c40';

// ── Match card ───────────────────────────────────────────────────────────────

interface MatchCardInput {
    ownTag: string;
    ownLogo: Image | null;
    opponentTag: string;
    opponentLogo: Image | null;
    gameType: 'official' | 'practice';
    scheduledDate: string;       // e.g. "Sun 22nd 21:30 CET"
}

export async function renderMatchCard(input: MatchCardInput): Promise<Buffer> {
    const canvas = createCanvas(W, MATCH_H);
    const ctx = canvas.getContext('2d');

    // Background with rounded corners
    drawRoundedRect(ctx, 0, 0, W, MATCH_H, CARD_RADIUS, COLORS.cellEmpty);

    // ── Layout zones ──
    // Left zone:   own logo + tag
    // Center zone: "vs" with swords
    // Right zone:  opponent logo + tag
    // Far right:   badge + date

    const centerX = W * 0.38;  // shift "vs" left to make room for date on right

    // Own team (left)
    const ownLogoX = 20 + LOGO_SIZE / 2;
    const logoY = MATCH_H * 0.42;
    drawLogo(ctx, input.ownLogo, input.ownTag, ownLogoX, logoY, LOGO_SIZE);

    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = COLORS.textPrimary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.ownTag, 20 + LOGO_SIZE + 10, logoY);

    // "vs" center
    ctx.font = `bold 11px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u2694  vs  \u2694', centerX, logoY);

    // Opponent team (right of center)
    const oppTagX = centerX + 40;
    ctx.font = `bold 14px ${FONT}`;
    ctx.fillStyle = COLORS.textPrimary;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.opponentTag, oppTagX, logoY);

    const oppTagW = ctx.measureText(input.opponentTag).width;
    const oppLogoX = oppTagX + oppTagW + 10 + LOGO_SIZE / 2;
    if (oppLogoX + LOGO_SIZE / 2 < W - 120) {
        drawLogo(ctx, input.opponentLogo, input.opponentTag, oppLogoX, logoY, LOGO_SIZE);
    } else {
        // Not enough space — draw logo after tag, tighter
        const tightLogoX = oppTagX + oppTagW + 8 + LOGO_SIZE / 2;
        drawLogo(ctx, input.opponentLogo, input.opponentTag, tightLogoX, logoY, LOGO_SIZE);
    }

    // Game type badge (far right, upper)
    const badgeColor = input.gameType === 'official' ? BADGE_OFFICIAL : BADGE_PRACTICE;
    const badgeText = input.gameType === 'official' ? 'OFFICIAL' : 'PRACTICE';
    drawBadge(ctx, badgeText, W - 12, 20, badgeColor);

    // Date/time (far right, lower)
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = COLORS.textSecondary;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText(input.scheduledDate, W - 12, 48);

    // Subtle bottom accent line (game type color)
    ctx.fillStyle = badgeColor;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(0, MATCH_H - 3, W, 3);
    ctx.globalAlpha = 1.0;

    return canvas.toBuffer('image/png');
}

// ── Proposal card ────────────────────────────────────────────────────────────

interface ProposalCardInput {
    opponentTag: string;
    opponentLogo: Image | null;
    viableSlots: number;
}

export async function renderProposalCard(input: ProposalCardInput): Promise<Buffer> {
    const canvas = createCanvas(W, PROPOSAL_H);
    const ctx = canvas.getContext('2d');

    // Background
    drawRoundedRect(ctx, 0, 0, W, PROPOSAL_H, CARD_RADIUS, PROPOSAL_BG);

    // Opponent logo (left)
    const logoX = 16 + LOGO_SIZE_SM / 2;
    const centerY = PROPOSAL_H / 2;
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

    // "view on site →" (far right)
    ctx.font = `10px ${FONT}`;
    ctx.fillStyle = '#6b7280';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillText('view on site \u2192', W - 12, centerY);

    // Subtle left accent bar (muted purple)
    ctx.fillStyle = COLORS.todayHighlight;
    ctx.globalAlpha = 0.4;
    drawRoundedRect(ctx, 0, 0, 3, PROPOSAL_H, CARD_RADIUS, COLORS.todayHighlight);
    ctx.globalAlpha = 1.0;

    return canvas.toBuffer('image/png');
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

/** Draw a small badge pill with text (right-aligned). */
function drawBadge(
    ctx: SKRSContext2D,
    text: string,
    rightX: number,
    centerY: number,
    color: string,
): void {
    ctx.font = `bold 9px ${FONT}`;
    const tw = ctx.measureText(text).width;
    const padX = 6;
    const bw = tw + padX * 2;
    const bh = 14;
    const bx = rightX - bw;
    const by = centerY - bh / 2;
    const r = bh / 2;

    // Pill shape
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Text
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + bw / 2, centerY);
}
