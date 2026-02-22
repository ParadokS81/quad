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

import { ChatInputCommandInteraction, ChannelType, Collection, Guild, GuildMember, MessageFlags, PermissionFlagsBits } from 'discord.js';
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

  // Build player mapping and guild member cache before activating
  let knownPlayers: Record<string, string> = {};
  let guildMembers: Record<string, GuildMemberEntry> = {};
  if (guild) {
    const fetchedMembers = await guild.members.fetch();
    knownPlayers = await buildKnownPlayers(data.teamId, guild, fetchedMembers);
    guildMembers = buildGuildMembersCache(guild.client.user!.id, fetchedMembers);
  }

  // Build available channels list for MatchScheduler dropdown
  let availableChannels: Array<{ id: string; name: string; canPost: boolean }> = [];
  if (guild) {
    try {
      const channels = await guild.channels.fetch();
      const me = guild.members.me;
      availableChannels = channels
        .filter(ch => ch !== null && ch.type === ChannelType.GuildText)
        .map(ch => {
          let canPost = false;
          if (me && ch) {
            const perms = ch.permissionsFor(me);
            canPost = perms.has(PermissionFlagsBits.SendMessages)
              && perms.has(PermissionFlagsBits.EmbedLinks);
          }
          return { id: ch!.id, name: ch!.name, canPost };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      logger.warn('Failed to fetch channels during registration', {
        guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Pick a default notification channel: system channel if bot can post, else first postable channel
  let defaultChannelId: string | null = null;
  if (guild) {
    const systemChannel = guild.systemChannel;
    if (systemChannel) {
      const match = availableChannels.find(ch => ch.id === systemChannel.id);
      if (match?.canPost) defaultChannelId = systemChannel.id;
    }
    if (!defaultChannelId) {
      const firstPostable = availableChannels.find(ch => ch.canPost);
      if (firstPostable) defaultChannelId = firstPostable.id;
    }
  }

  // Activate the registration with the player mapping, guild members, channels, and default notification channel
  await doc.ref.update({
    guildId,
    guildName,
    knownPlayers,
    guildMembers,
    availableChannels,
    notificationChannelId: defaultChannelId,
    notificationsEnabled: !!defaultChannelId,
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
    ? `Mapped **${mappedCount}** player(s) from the team roster to Discord members.`
    : 'No player mappings found — make sure team members have linked their Discord on MatchScheduler.';

  // Check voice channel permissions — warn if the bot can't connect to any voice channel
  let voiceWarning = '';
  if (guild) {
    const me = guild.members.me;
    if (me) {
      const channels = await guild.channels.fetch();
      const voiceChannels = channels.filter(
        ch => ch !== null && (ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice)
      );
      const canJoinAny = voiceChannels.some(ch => {
        const perms = ch!.permissionsFor(me);
        return perms.has(PermissionFlagsBits.ViewChannel)
          && perms.has(PermissionFlagsBits.Connect)
          && perms.has(PermissionFlagsBits.Speak);
      });
      if (!canJoinAny && voiceChannels.size > 0) {
        voiceWarning = '\n\n⚠️ **Warning:** The bot cannot connect to any voice channel. Recording will fail until permissions are fixed.\nGo to a voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable **View Channel**, **Connect**, and **Speak**.';
      } else if (voiceChannels.size === 0) {
        voiceWarning = '\n\n⚠️ **Warning:** No voice channels found in this server.';
      }
    }
  }

  await interaction.reply({
    content: `This server is now linked to **${data.teamName}** (${data.teamTag}). Voice recordings from this server will be associated with your team.\n${mappingNote}${voiceWarning}`,
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
async function buildKnownPlayers(
  teamId: string,
  guild: Guild,
  guildMembers: Collection<string, GuildMember>,
): Promise<Record<string, string>> {
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

export interface GuildMemberEntry {
  username: string;
  displayName: string;
  avatarUrl: string | null;
  isBot: boolean;
}

/**
 * Build a discordUserId → GuildMemberEntry map for all guild members.
 * Excludes the bot itself.
 */
export function buildGuildMembersCache(
  botUserId: string,
  members: Collection<string, GuildMember>,
): Record<string, GuildMemberEntry> {
  const cache: Record<string, GuildMemberEntry> = {};

  for (const [id, member] of members) {
    if (id === botUserId) continue;
    cache[id] = {
      username: member.user.username,
      displayName: member.displayName,
      avatarUrl: member.user.displayAvatarURL({ size: 128 }),
      isBot: member.user.bot,
    };
  }

  return cache;
}
