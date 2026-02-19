/**
 * /register command handler and registration helpers.
 *
 * Completes a pending bot registration by linking a Discord guild to a team.
 * The pending registration is created by MatchScheduler (Phase 1a) — this command
 * finds it by the user's Discord ID and activates it with the guild info.
 *
 * At registration time, builds a knownPlayers mapping (discordUserId → QW name)
 * by cross-referencing the team roster from MatchScheduler with Discord guild members.
 * This mapping is critical for match pairing — it lets the pipeline know which
 * QW Hub matches belong to this team.
 */

import { ChatInputCommandInteraction, ChannelType, Guild, MessageFlags } from 'discord.js';
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
  // Support both new array field (authorizedDiscordUserIds) and old single field (authorizedDiscordUserId)
  const [arraySnap, singleSnap] = await Promise.all([
    db.collection('botRegistrations')
      .where('authorizedDiscordUserIds', 'array-contains', userId)
      .where('status', '==', 'pending')
      .limit(1)
      .get(),
    db.collection('botRegistrations')
      .where('authorizedDiscordUserId', '==', userId)
      .where('status', '==', 'pending')
      .limit(1)
      .get(),
  ]);

  const pendingDoc = arraySnap.docs[0] || singleSnap.docs[0];

  if (!pendingDoc) {
    await interaction.reply({
      content: `No pending registration found. Start the setup from your team settings on MatchScheduler: ${SCHEDULER_URL}`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const doc = pendingDoc;
  const data = doc.data();
  const guild = interaction.guild;
  const guildName = guild?.name || 'Unknown';

  // Build player mapping before activating
  let knownPlayers: Record<string, string> = {};
  if (guild) {
    knownPlayers = await buildKnownPlayers(data.teamId, guild);
  }

  // Build available channels list for MatchScheduler dropdown
  let availableChannels: Array<{ id: string; name: string }> = [];
  if (guild) {
    try {
      const channels = await guild.channels.fetch();
      availableChannels = channels
        .filter(ch => ch !== null && ch.type === ChannelType.GuildText)
        .map(ch => ({ id: ch!.id, name: ch!.name }))
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      logger.warn('Failed to fetch channels during registration', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Activate the registration with the player mapping and available channels
  await doc.ref.update({
    guildId,
    guildName,
    knownPlayers,
    availableChannels,
    status: 'active',
    activatedAt: new Date(),
    updatedAt: new Date(),
  });

  const mappedCount = Object.keys(knownPlayers).length;

  logger.info('Bot registration activated', {
    teamId: data.teamId,
    teamTag: data.teamTag,
    guildId,
    guildName,
    activatedBy: userId,
    mappedPlayers: mappedCount,
  });

  const mappingNote = mappedCount > 0
    ? `\nMapped **${mappedCount}** player(s) from the team roster to Discord members.`
    : '\nNo player mappings found — make sure team members have linked their Discord on MatchScheduler.';

  await interaction.reply({
    content: `This server is now linked to **${data.teamName}** (${data.teamTag}). Voice recordings from this server will be associated with your team.${mappingNote}`,
    flags: MessageFlags.Ephemeral,
  });
}

/**
 * Build a discordUserId → QW name mapping by cross-referencing the team roster
 * from MatchScheduler Firestore with members of the Discord guild.
 *
 * Queries `users` collection for members of this team, then checks which of them
 * have a discordUserId that exists in the guild.
 */
async function buildKnownPlayers(teamId: string, guild: Guild): Promise<Record<string, string>> {
  const db = getDb();
  const knownPlayers: Record<string, string> = {};

  try {
    // Get all users on this team from MatchScheduler
    const usersSnap = await db.collection('users')
      .where(`teams.${teamId}`, '==', true)
      .get();

    if (usersSnap.empty) {
      logger.info('No users found for team in Firestore', { teamId });
      return knownPlayers;
    }

    // Fetch guild members so we can verify they're in the server
    const guildMembers = await guild.members.fetch();

    for (const userDoc of usersSnap.docs) {
      const userData = userDoc.data();
      const discordId = userData.discordUserId as string | undefined;
      const qwName = userData.displayName as string | undefined;

      if (!discordId || !qwName) continue;

      // Only include if the Discord user is actually in this guild
      if (guildMembers.has(discordId)) {
        knownPlayers[discordId] = qwName;
        logger.info('Mapped player', { discordId, qwName });
      } else {
        logger.info('Team member not in guild, skipping', { discordId, qwName });
      }
    }

    logger.info('Player mapping complete', {
      teamId,
      rosterSize: usersSnap.size,
      mappedCount: Object.keys(knownPlayers).length,
    });
  } catch (err) {
    logger.error('Failed to build player mapping', {
      teamId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return knownPlayers;
}
