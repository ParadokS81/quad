/**
 * /register command handler and registration helpers.
 *
 * Completes a pending bot registration by linking a Discord guild to a team.
 * The pending registration is created by MatchScheduler (Phase 1a) — this command
 * finds it by the user's Discord ID and activates it with the guild info.
 */

import { ChatInputCommandInteraction, MessageFlags } from 'discord.js';
import { getDb } from '../standin/firestore.js';
import { logger } from '../../core/logger.js';

const SCHEDULER_URL = process.env.SCHEDULER_URL || 'https://matchscheduler.web.app';

export interface BotRegistration {
  teamId: string;
  teamTag: string;
  teamName: string;
  guildId: string;
  guildName: string;
  knownPlayers: Record<string, string>; // discordUserId → QW name
}

/** Get the active bot registration for a guild, or null if not registered. */
export async function getRegistrationForGuild(guildId: string): Promise<BotRegistration | null> {
  const db = getDb();
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) return null;

  const data = snap.docs[0].data();
  return {
    teamId: data.teamId,
    teamTag: data.teamTag,
    teamName: data.teamName,
    guildId: data.guildId,
    guildName: data.guildName,
    knownPlayers: data.knownPlayers || {},
  };
}

export async function handleRegister(interaction: ChatInputCommandInteraction): Promise<void> {
  const db = getDb();
  const userId = interaction.user.id;
  const guildId = interaction.guildId;

  if (!guildId) {
    await interaction.reply({
      content: 'This command must be used in a server, not in DMs.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Check if this guild already has an active registration
  const existingReg = await getRegistrationForGuild(guildId);
  if (existingReg) {
    await interaction.reply({
      content: `This server is linked to **${existingReg.teamName}** (${existingReg.teamTag}). To change, disconnect from team settings on MatchScheduler first.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  // Find a pending registration for this user
  const pendingSnap = await db.collection('botRegistrations')
    .where('authorizedDiscordUserId', '==', userId)
    .where('status', '==', 'pending')
    .limit(1)
    .get();

  if (pendingSnap.empty) {
    await interaction.reply({
      content: `No pending registration found. Start the setup from your team settings on MatchScheduler: ${SCHEDULER_URL}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const doc = pendingSnap.docs[0];
  const data = doc.data();
  const guildName = interaction.guild?.name || 'Unknown';

  // Activate the registration
  await doc.ref.update({
    guildId,
    guildName,
    status: 'active',
    activatedAt: new Date(),
    updatedAt: new Date(),
  });

  logger.info('Bot registration activated', {
    teamId: data.teamId,
    teamTag: data.teamTag,
    guildId,
    guildName,
    activatedBy: userId,
  });

  await interaction.reply({
    content: `This server is now linked to **${data.teamName}** (${data.teamTag}). Voice recordings from this server will be associated with your team.`,
    flags: MessageFlags.Ephemeral,
  });
}
