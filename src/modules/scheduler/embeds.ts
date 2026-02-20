/**
 * Discord embed builders for scheduler notifications.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { type ChallengeNotification, type SlotConfirmedNotification, type MatchSealedNotification } from './types.js';

const DAYS: Record<string, string> = {
  mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu',
  fri: 'Fri', sat: 'Sat', sun: 'Sun',
};
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * Convert a UTC slot ID to CET (UTC+1) display string.
 * Slot IDs are UTC (e.g., "sun_2130" = Sunday 21:30 UTC).
 *
 * CET = UTC+1 year-round in v1 — the QW community universally says "CET" even during summer.
 *
 * Returns e.g., "Sun 22:30" (for "sun_2130" + 1 hour)
 */
function formatSlotForCET(slotId: string): string {
  const [day, time] = slotId.split('_');
  if (!time) return DAYS[day] || day;

  const utcHour = parseInt(time.slice(0, 2), 10);
  const utcMin = time.slice(2);

  // Add 1 hour for CET
  let cetHour = utcHour + 1;
  let displayDay = day;

  if (cetHour >= 24) {
    cetHour -= 24;
    const dayIdx = DAY_ORDER.indexOf(day);
    displayDay = DAY_ORDER[(dayIdx + 1) % 7];
  }

  return `${DAYS[displayDay] || displayDay} ${String(cetHour).padStart(2, '0')}:${utcMin}`;
}

/**
 * Apply team logos to an embed.
 * perspective: 'opponent' = someone else challenged you, 'proposer' = you sent the challenge, 'neutral' = informational
 */
function applyLogos(
  embed: EmbedBuilder,
  data: { proposerLogoUrl: string | null; opponentLogoUrl: string | null; proposerTeamTag?: string; proposerTeamName?: string },
  perspective: 'opponent' | 'proposer' | 'neutral',
): void {
  if (perspective === 'opponent') {
    // Proposer's logo as author (they're the actor), opponent's as thumbnail
    if (data.proposerLogoUrl) {
      const name = data.proposerTeamTag
        ? `${data.proposerTeamTag} ${data.proposerTeamName}`
        : (data.proposerTeamName ?? 'Challenger');
      embed.setAuthor({ name, iconURL: data.proposerLogoUrl });
    }
    if (data.opponentLogoUrl) embed.setThumbnail(data.opponentLogoUrl);
  } else if (perspective === 'proposer') {
    // Opponent's logo as thumbnail (they're who you challenged)
    if (data.opponentLogoUrl) embed.setThumbnail(data.opponentLogoUrl);
  } else {
    // Neutral: proposer logo as author icon, opponent as thumbnail
    if (data.proposerLogoUrl) {
      embed.setAuthor({ name: 'Match Scheduled', iconURL: data.proposerLogoUrl });
    }
    if (data.opponentLogoUrl) embed.setThumbnail(data.opponentLogoUrl);
  }
}

/**
 * Build the challenge embed sent to the opponent's channel (or DM).
 */
export function buildChallengeEmbed(notification: ChallengeNotification): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
} {
  const proposerDisplay = notification.proposerTeamTag
    ? `${notification.proposerTeamTag} ${notification.proposerTeamName}`
    : notification.proposerTeamName;

  const opponentDisplay = notification.opponentTeamTag
    ? `${notification.opponentTeamTag} ${notification.opponentTeamName}`
    : notification.opponentTeamName;

  const gameTypeLabel = notification.gameType === 'official' ? 'Official' : 'Practice';
  const weekNum = notification.weekId.split('-')[1];

  const slotLines = notification.confirmedSlots.map(slot => {
    const display = formatSlotForCET(slot.slotId);
    return `▸ ${display} CET (${slot.proposerCount}v${slot.opponentCount})`;
  });

  const embed = new EmbedBuilder()
    .setColor(notification.gameType === 'official' ? 0x22c55e : 0xf59e0b)
    .setTitle(`New Challenge — ${gameTypeLabel}`)
    .setDescription(
      `**${proposerDisplay}** challenged **${opponentDisplay}**\nWeek ${weekNum}`,
    )
    .addFields({
      name: 'Proposed times',
      value: slotLines.join('\n') || 'No specific times',
    });

  applyLogos(embed, notification, 'opponent');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('View Proposal')
      .setStyle(ButtonStyle.Link)
      .setURL(notification.proposalUrl),
  );

  if (notification.proposerLeaderDiscordId) {
    const dmLabel = notification.proposerLeaderDisplayName
      ? `DM ${notification.proposerLeaderDisplayName}`
      : 'DM Challenger';

    row.addComponents(
      new ButtonBuilder()
        .setLabel(dmLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/users/${notification.proposerLeaderDiscordId}`),
    );
  }

  return { embed, row };
}

/**
 * Build the confirmation embed sent to the proposer's own channel.
 */
export function buildProposerEmbed(notification: ChallengeNotification): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
} {
  const opponentDisplay = notification.opponentTeamTag
    ? `${notification.opponentTeamTag} ${notification.opponentTeamName}`
    : notification.opponentTeamName;

  const gameTypeLabel = notification.gameType === 'official' ? 'Official' : 'Practice';
  const weekNum = notification.weekId.split('-')[1];

  const slotLines = notification.confirmedSlots.map(slot => {
    const display = formatSlotForCET(slot.slotId);
    return `▸ ${display} CET (${slot.proposerCount}v${slot.opponentCount})`;
  });

  const embed = new EmbedBuilder()
    .setColor(notification.gameType === 'official' ? 0x22c55e : 0xf59e0b)
    .setTitle(`Challenge Sent — ${gameTypeLabel}`)
    .setDescription(
      `You challenged **${opponentDisplay}** for Week ${weekNum}`,
    )
    .addFields({
      name: 'Proposed times',
      value: slotLines.join('\n') || 'No specific times',
    });

  applyLogos(embed, notification, 'proposer');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('View Proposal')
      .setStyle(ButtonStyle.Link)
      .setURL(notification.proposalUrl),
  );

  return { embed, row };
}

/**
 * Build the slot-confirmed embed sent to the OTHER team when one side confirms a timeslot.
 */
export function buildSlotConfirmedEmbed(notification: SlotConfirmedNotification): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
} {
  const confirmerDisplay = notification.confirmedByTeamTag
    ? `${notification.confirmedByTeamTag} ${notification.confirmedByTeamName}`
    : notification.confirmedByTeamName;

  const slotDisplay = formatSlotForCET(notification.slotId);
  const gameTypeLabel = notification.gameType === 'official' ? 'Official' : 'Practice';

  const embed = new EmbedBuilder()
    .setColor(0x3b82f6) // Blue — informational action
    .setTitle(`Slot Confirmed — ${gameTypeLabel}`)
    .setDescription(`**${confirmerDisplay}** confirmed **${slotDisplay} CET**`);

  // Determine which logo belongs to the confirmer for author icon
  const isConfirmerProposer = notification.confirmedByTeamId === notification.proposerTeamId;
  const confirmerLogo = isConfirmerProposer ? notification.proposerLogoUrl : notification.opponentLogoUrl;
  const otherLogo = isConfirmerProposer ? notification.opponentLogoUrl : notification.proposerLogoUrl;

  if (confirmerLogo) {
    embed.setAuthor({ name: confirmerDisplay, iconURL: confirmerLogo });
  }
  if (otherLogo) {
    embed.setThumbnail(otherLogo);
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('View Proposal')
      .setStyle(ButtonStyle.Link)
      .setURL(notification.proposalUrl),
  );

  if (notification.confirmedByDiscordId) {
    const dmLabel = notification.confirmedByDisplayName
      ? `DM ${notification.confirmedByDisplayName}`
      : 'DM Them';
    row.addComponents(
      new ButtonBuilder()
        .setLabel(dmLabel)
        .setStyle(ButtonStyle.Link)
        .setURL(`https://discord.com/users/${notification.confirmedByDiscordId}`),
    );
  }

  return { embed, row };
}

/**
 * Build the match-sealed embed sent to EACH team when a match is mutually confirmed.
 */
export function buildMatchSealedEmbed(notification: MatchSealedNotification): {
  embed: EmbedBuilder;
  row: ActionRowBuilder<ButtonBuilder>;
} {
  const proposerDisplay = notification.proposerTeamTag
    ? `${notification.proposerTeamTag} ${notification.proposerTeamName}`
    : notification.proposerTeamName;

  const opponentDisplay = notification.opponentTeamTag
    ? `${notification.opponentTeamTag} ${notification.opponentTeamName}`
    : notification.opponentTeamName;

  const slotDisplay = formatSlotForCET(notification.slotId);
  const gameTypeLabel = notification.gameType === 'official' ? 'Official' : 'Practice';
  const weekNum = notification.weekId.split('-')[1];

  const embed = new EmbedBuilder()
    .setColor(0x22c55e) // Green — success!
    .setTitle(`Match Scheduled — ${gameTypeLabel}`)
    .setDescription(
      `**${proposerDisplay}** vs **${opponentDisplay}**\n**${slotDisplay} CET** — Week ${weekNum}`,
    );

  applyLogos(embed, notification, 'neutral');

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setLabel('View Match')
      .setStyle(ButtonStyle.Link)
      .setURL(notification.proposalUrl),
  );

  return { embed, row };
}
