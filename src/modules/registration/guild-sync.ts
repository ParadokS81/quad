import { Client, Events, GuildMember, PartialGuildMember } from 'discord.js';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../standin/firestore.js';
import { buildGuildMembersCache, GuildMemberEntry } from './register.js';
import { logger } from '../../core/logger.js';

async function findRegistrationByGuildId(guildId: string) {
  const db = getDb();
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snap.empty) return null;
  return snap.docs[0];
}

function memberToEntry(member: GuildMember): GuildMemberEntry {
  return {
    username: member.user.username,
    displayName: member.displayName,
    avatarUrl: member.user.displayAvatarURL({ size: 128 }),
    isBot: member.user.bot,
  };
}

/**
 * Register event handlers for guild member join/leave.
 * Call this once after the Discord client is ready.
 */
export function registerGuildSyncEvents(client: Client): void {
  client.on(Events.GuildMemberAdd, async (member: GuildMember) => {
    if (member.user.id === client.user?.id) return;

    try {
      const reg = await findRegistrationByGuildId(member.guild.id);
      if (!reg) return;

      await reg.ref.update({
        [`guildMembers.${member.user.id}`]: memberToEntry(member),
      });

      logger.info('Guild member added to cache', {
        guildId: member.guild.id,
        userId: member.user.id,
        username: member.user.username,
      });
    } catch (err) {
      logger.error('Failed to sync guild member add', {
        guildId: member.guild.id,
        userId: member.user.id,
        error: String(err),
      });
    }
  });

  client.on(Events.GuildMemberRemove, async (member: GuildMember | PartialGuildMember) => {
    try {
      const reg = await findRegistrationByGuildId(member.guild.id);
      if (!reg) return;

      await reg.ref.update({
        [`guildMembers.${member.user!.id}`]: FieldValue.delete(),
      });

      logger.info('Guild member removed from cache', {
        guildId: member.guild.id,
        userId: member.user!.id,
      });
    } catch (err) {
      logger.error('Failed to sync guild member remove', {
        guildId: member.guild.id,
        userId: member.user?.id,
        error: String(err),
      });
    }
  });

  logger.info('Guild member sync events registered');
}

/**
 * Refresh the guildMembers cache for all active registrations.
 * Call this on bot startup.
 */
export async function refreshAllGuildMembers(client: Client): Promise<void> {
  const db = getDb();
  const regs = await db.collection('botRegistrations')
    .where('status', '==', 'active')
    .get();

  let refreshed = 0;

  for (const reg of regs.docs) {
    const guildId = reg.data().guildId as string | undefined;
    if (!guildId) continue;

    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn('Guild not in cache, skipping refresh', { guildId, teamId: reg.id });
      continue;
    }

    try {
      const members = await guild.members.fetch();
      const cache = buildGuildMembersCache(client.user!.id, members);

      await reg.ref.update({ guildMembers: cache });
      refreshed++;

      logger.info('Refreshed guild members cache', {
        guildId,
        teamId: reg.id,
        memberCount: Object.keys(cache).length,
      });
    } catch (err) {
      logger.error('Failed to refresh guild members', {
        guildId,
        teamId: reg.id,
        error: String(err),
      });
    }
  }

  logger.info(`Guild member refresh complete: ${refreshed} guilds updated`);
}
