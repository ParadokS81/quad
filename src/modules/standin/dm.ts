/**
 * Discord DM builder — constructs embeds and action rows for standin request messages.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type User,
} from 'discord.js';
import { type StandinRequest } from './types.js';

/**
 * Send the initial standin request DM to a candidate.
 */
export async function sendStandinRequestDM(
  user: User,
  request: StandinRequest,
  requestId: string,
  schedulerUrl: string,
): Promise<void> {
  const { requestedBy, match } = request;

  const teamDisplay = requestedBy.teamTag
    ? `${requestedBy.teamName} ${requestedBy.teamTag}`
    : requestedBy.teamName;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2) // Discord blurple
    .setTitle('Standin Request')
    .setDescription(`**${teamDisplay}** is looking for a standin`)
    .addFields(
      { name: 'Time', value: match.displayTime, inline: true },
      { name: 'Division', value: match.division, inline: true },
    );

  if (match.opponent) {
    embed.addFields({ name: 'Opponent', value: match.opponent, inline: true });
  }

  if (requestedBy.teamLogoUrl) {
    embed.setThumbnail(requestedBy.teamLogoUrl);
  }

  embed.setFooter({ text: `Requested by ${requestedBy.displayName}` });

  // Row 1: Yes / No
  const responseRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`standin_yes_${requestId}`)
      .setLabel('Yes, I can play')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`standin_no_${requestId}`)
      .setLabel('No thanks')
      .setStyle(ButtonStyle.Danger),
  );

  // Row 2: Stop all + Preferences link
  const prefsUrl = buildPreferencesUrl(schedulerUrl, requestedBy.teamId, match.division);

  const controlRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`standin_stop_${requestId}`)
      .setLabel('Stop all requests')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setLabel('Preferences')
      .setStyle(ButtonStyle.Link)
      .setURL(prefsUrl),
  );

  await user.send({ embeds: [embed], components: [responseRow, controlRow] });
}

/**
 * Send confirmation DM to the chosen standin.
 */
export async function sendConfirmationDM(
  user: User,
  request: StandinRequest,
): Promise<void> {
  const { requestedBy, match } = request;

  const teamDisplay = requestedBy.teamTag
    ? `${requestedBy.teamName} ${requestedBy.teamTag}`
    : requestedBy.teamName;

  const embed = new EmbedBuilder()
    .setColor(0x57f287) // Green
    .setTitle("You're in!")
    .setDescription(`**${teamDisplay}** confirmed you as standin`)
    .addFields(
      { name: 'Time', value: match.displayTime, inline: true },
    );

  if (match.opponent) {
    embed.addFields({ name: 'Opponent', value: match.opponent, inline: true });
  }

  if (requestedBy.teamLogoUrl) {
    embed.setThumbnail(requestedBy.teamLogoUrl);
  }

  embed.setFooter({ text: 'Join the voice channel when ready. glhf!' });

  await user.send({ embeds: [embed] });
}

/**
 * Send "slot filled" DM to candidates who accepted but weren't chosen.
 */
export async function sendRejectionDM(
  user: User,
  request: StandinRequest,
): Promise<void> {
  const { requestedBy, match } = request;

  const teamDisplay = requestedBy.teamTag
    ? `${requestedBy.teamName} ${requestedBy.teamTag}`
    : requestedBy.teamName;

  const embed = new EmbedBuilder()
    .setColor(0x99aab5) // Grey
    .setTitle('Standin slot filled')
    .setDescription(
      `**${teamDisplay}** found a standin for ${match.displayTime}. Thanks for responding!`,
    );

  await user.send({ embeds: [embed] });
}

/**
 * Build deep-linked preferences URL with optional context.
 */
function buildPreferencesUrl(
  baseUrl: string,
  teamId: string,
  division: string,
): string {
  const params = new URLSearchParams({ teamId, div: division });
  return `${baseUrl}/#standin-preferences?${params.toString()}`;
}
