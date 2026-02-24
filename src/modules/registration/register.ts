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

import { ChatInputCommandInteraction, ChannelType, Client, Collection, Guild, GuildMember, GuildChannel, MessageFlags, PermissionFlagsBits } from 'discord.js';
import { getDb } from '../standin/firestore.js';
import { logger } from '../../core/logger.js';

const SCHEDULER_URL = process.env.SCHEDULER_URL || 'https://matchscheduler.web.app';

// Per-session throttle — only DM each team once per bot process run to avoid spam
const permErrorNotifiedTeams = new Set<string>();

/**
 * DM the user who ran /register to warn them about a channel permission issue.
 * Best-effort — logs but does not throw. Throttled once per team per process run.
 */
export async function dmRegistrantAboutPermissions(
  client: Client,
  teamId: string,
  channelId: string,
): Promise<void> {
  if (permErrorNotifiedTeams.has(teamId)) return;
  const db = getDb();
  try {
    const regDoc = await db.collection('botRegistrations').doc(teamId).get();
    if (!regDoc.exists) return;
    const registrantId: string | undefined = regDoc.data()?.registrantDiscordUserId;
    if (!registrantId) return;

    const user = await client.users.fetch(registrantId);
    await user.send([
      `⚠️ **Quad Bot — Channel permission issue**`,
      ``,
      `I'm missing permissions to post in <#${channelId}>.`,
      ``,
      `Make sure I have **Send Messages** and **Embed Links** in that channel, or pick a different channel at ${SCHEDULER_URL}/#/settings/discord`,
    ].join('\n'));
    permErrorNotifiedTeams.add(teamId);
    logger.info('Sent channel permission warning DM to registrant', { teamId, channelId, registrantId });
  } catch (err) {
    logger.warn('Failed to DM registrant about channel permission issue', {
      teamId,
      channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export interface BotRegistration {
  teamId: string;
  teamTag: string;
  teamName: string;
  guildId: string;
  guildName: string;
  knownPlayers: Record<string, string>; // discordUserId → QW name
  registeredChannelId: string | null;
  registeredCategoryId: string | null;
  registeredCategoryName: string | null;
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
    registeredChannelId: data.registeredChannelId || null,
    registeredCategoryId: data.registeredCategoryId || null,
    registeredCategoryName: data.registeredCategoryName || null,
  };
}

/**
 * Resolve the correct registration for a specific channel context.
 * - Single registration guild: returns it directly (no ambiguity)
 * - Multi registration guild: matches by registeredChannelId or registeredCategoryId
 * - No match: returns null
 */
export async function resolveRegistrationForChannel(
  guildId: string,
  channelId: string,
  client: Client,
): Promise<BotRegistration | null> {
  const registrations = await getRegistrationsForGuild(guildId);

  if (registrations.length === 0) return null;
  if (registrations.length === 1) return registrations[0];

  // Multiple registrations — try exact channel match first
  const exactMatch = registrations.find(r => r.registeredChannelId === channelId);
  if (exactMatch) return exactMatch;

  // Try category match
  try {
    const channel = await client.channels.fetch(channelId);
    const categoryId = (channel as any)?.parentId;
    if (categoryId) {
      const categoryMatch = registrations.find(r => r.registeredCategoryId === categoryId);
      if (categoryMatch) return categoryMatch;
    }
  } catch {
    // Channel fetch failed — fall through to null
  }

  return null;
}

/** Get ALL active bot registrations for a guild. */
export async function getRegistrationsForGuild(guildId: string): Promise<BotRegistration[]> {
  const db = getDb();
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .get();

  return snap.docs.map(doc => {
    const data = doc.data();
    return {
      teamId: data.teamId,
      teamTag: data.teamTag,
      teamName: data.teamName,
      guildId: data.guildId,
      guildName: data.guildName,
      knownPlayers: data.knownPlayers || {},
      registeredChannelId: data.registeredChannelId || null,
      registeredCategoryId: data.registeredCategoryId || null,
      registeredCategoryName: data.registeredCategoryName || null,
    };
  });
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

  // Activate the registration with the player mapping, guild members, and channels
  await doc.ref.update({
    guildId,
    guildName,
    knownPlayers,
    guildMembers,
    availableChannels,
    registrantDiscordUserId: userId,
    registeredChannelId: interaction.channelId,
    registeredCategoryId: interaction.channel instanceof GuildChannel ? interaction.channel.parentId : null,
    registeredCategoryName: interaction.channel instanceof GuildChannel ? interaction.channel.parent?.name || null : null,
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
          && perms.has(PermissionFlagsBits.Speak)
          && perms.has(PermissionFlagsBits.MoveMembers);
      });
      if (!canJoinAny && voiceChannels.size > 0) {
        voiceWarning = '\n\n⚠️ **Warning:** The bot is missing permissions on voice channels. Recording may fail.\nGo to a voice channel → **Edit Channel** → **Permissions** → add the bot\'s role → enable **View Channel**, **Connect**, **Speak**, and **Move Members**.';
      } else if (voiceChannels.size === 0) {
        voiceWarning = '\n\n⚠️ **Warning:** No voice channels found in this server.';
      }
    }
  }

  // Check if other teams are registered in this guild
  const otherRegs = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .get();
  // Subtract 1 because we just activated our own
  const otherTeamCount = otherRegs.size - 1;

  // Multi-team guild: disable auto-record on all registrations (future-proofing)
  if (otherTeamCount > 0) {
    for (const regDoc of otherRegs.docs) {
      const regData = regDoc.data();
      if (regData.autoRecord?.enabled) {
        await regDoc.ref.update({
          'autoRecord.enabled': false,
          updatedAt: new Date(),
        });
        logger.info('Disabled auto-record for multi-team guild', {
          teamId: regData.teamId,
          guildId,
        });
      }
    }
  }

  const channelNote = otherTeamCount > 0
    ? `\nThis server has **${otherTeamCount + 1}** teams registered. Use \`/record start\` from this channel to start a recording session.`
    : '';

  // Tell the user which notification channel was auto-selected (or warn if none found)
  const scheduleNote = `\n\nSet up a **#schedule** channel at ${SCHEDULER_URL}/#/settings/discord to see availability grids and match notifications.`;

  await interaction.reply({
    content: `This server is now linked to **${data.teamName}** (${data.teamTag}). Voice recordings from this server will be associated with your team.\n${mappingNote}${channelNote}${scheduleNote}${voiceWarning}`,
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
