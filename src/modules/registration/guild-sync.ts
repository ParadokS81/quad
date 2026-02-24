import { Client, Events, GuildMember, PartialGuildMember } from 'discord.js';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../standin/firestore.js';
import { buildGuildMembersCache, GuildMemberEntry } from './register.js';
import { logger } from '../../core/logger.js';

async function findRegistrationsByGuildId(guildId: string) {
  const db = getDb();
  const snap = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .get();

  return snap.docs;  // Returns array, may be empty
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
      const regs = await findRegistrationsByGuildId(member.guild.id);
      if (regs.length === 0) return;

      const entry = memberToEntry(member);
      for (const reg of regs) {
        await reg.ref.update({
          [`guildMembers.${member.user.id}`]: entry,
        });
      }

      logger.info('Guild member added to cache', {
        guildId: member.guild.id,
        userId: member.user.id,
        username: member.user.username,
        registrationsUpdated: regs.length,
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
      const regs = await findRegistrationsByGuildId(member.guild.id);
      if (regs.length === 0) return;

      for (const reg of regs) {
        await reg.ref.update({
          [`guildMembers.${member.user!.id}`]: FieldValue.delete(),
        });
      }

      logger.info('Guild member removed from cache', {
        guildId: member.guild.id,
        userId: member.user!.id,
        registrationsUpdated: regs.length,
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
 * Groups by guildId to avoid redundant member fetches for multi-team guilds.
 * Call this on bot startup.
 */
export async function refreshAllGuildMembers(client: Client): Promise<void> {
  const db = getDb();
  const regs = await db.collection('botRegistrations')
    .where('status', '==', 'active')
    .get();

  // Group by guildId to avoid redundant member fetches for multi-team guilds
  const byGuild = new Map<string, FirebaseFirestore.QueryDocumentSnapshot[]>();
  for (const reg of regs.docs) {
    const guildId = reg.data().guildId as string | undefined;
    if (!guildId) continue;
    if (!byGuild.has(guildId)) byGuild.set(guildId, []);
    byGuild.get(guildId)!.push(reg);
  }

  let refreshed = 0;

  for (const [guildId, guildRegs] of byGuild) {
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      logger.warn('Guild not in cache, skipping refresh', { guildId });
      continue;
    }

    try {
      const members = await guild.members.fetch();
      const cache = buildGuildMembersCache(client.user!.id, members);

      for (const reg of guildRegs) {
        await reg.ref.update({ guildMembers: cache });
        refreshed++;
      }

      logger.info('Refreshed guild members cache', {
        guildId,
        registrations: guildRegs.length,
        memberCount: Object.keys(cache).length,
      });
    } catch (err) {
      logger.error('Failed to refresh guild members', {
        guildId,
        error: String(err),
      });
    }
  }

  logger.info(`Guild member refresh complete: ${refreshed} registrations updated`);
}
