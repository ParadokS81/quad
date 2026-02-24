/**
 * Channel discovery — writes availableChannels to botRegistrations
 * so the MatchScheduler Discord settings dropdown has data.
 */

import { type Client, ChannelType, PermissionFlagsBits } from 'discord.js';
import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';

interface ChannelInfo {
  id: string;
  name: string;
  canPost: boolean;
}

/**
 * Get all text channels the bot can see in a guild, with posting permission info.
 */
export async function getTextChannels(client: Client, guildId: string): Promise<ChannelInfo[]> {
  const guild = await client.guilds.fetch(guildId);
  const channels = await guild.channels.fetch();
  const me = guild.members.me;

  return channels
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
}

/**
 * Sync channel lists for all active bot registrations.
 * Called on module startup.
 */
export async function syncAllGuildChannels(db: Firestore, client: Client): Promise<void> {
  const snapshot = await db.collection('botRegistrations')
    .where('status', '==', 'active')
    .get();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!data.guildId) continue;

    try {
      const channels = await getTextChannels(client, data.guildId);
      await doc.ref.update({
        availableChannels: channels,
        updatedAt: new Date(),
      });
      logger.debug('Synced channels for guild', {
        guildId: data.guildId,
        teamId: data.teamId,
        channelCount: channels.length,
      });
    } catch (err) {
      logger.warn('Failed to sync channels for guild', {
        guildId: data.guildId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Sync channels for a single guild. Used when a registration is activated.
 * Updates ALL active registrations for the guild (multi-team support).
 */
export async function syncGuildChannels(
  db: Firestore,
  client: Client,
  guildId: string,
): Promise<void> {
  const snapshot = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .get();

  if (snapshot.empty) return;

  const channels = await getTextChannels(client, guildId);
  for (const doc of snapshot.docs) {
    try {
      await doc.ref.update({
        availableChannels: channels,
        updatedAt: new Date(),
      });
      logger.info('Synced channels for newly registered guild', {
        guildId,
        teamId: doc.data().teamId,
        channelCount: channels.length,
      });
    } catch (err) {
      logger.warn('Failed to sync channels for registration', {
        guildId,
        teamId: doc.data().teamId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
