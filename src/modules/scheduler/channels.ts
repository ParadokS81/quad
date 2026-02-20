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
async function getTextChannels(client: Client, guildId: string): Promise<ChannelInfo[]> {
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
      const update: Record<string, unknown> = {
        availableChannels: channels,
        updatedAt: new Date(),
      };

      // Backfill default notification channel for existing registrations that don't have one
      if (!data.notificationChannelId) {
        const guild = await client.guilds.fetch(data.guildId);
        const systemChannelId = guild.systemChannel?.id;
        let defaultId: string | null = null;

        if (systemChannelId) {
          const match = channels.find(ch => ch.id === systemChannelId);
          if (match?.canPost) defaultId = systemChannelId;
        }
        if (!defaultId) {
          const firstPostable = channels.find(ch => ch.canPost);
          if (firstPostable) defaultId = firstPostable.id;
        }

        if (defaultId) {
          update.notificationChannelId = defaultId;
          update.notificationsEnabled = true;
          logger.info('Set default notification channel for guild', {
            guildId: data.guildId,
            teamId: data.teamId,
            channelId: defaultId,
          });
        }
      }

      await doc.ref.update(update);
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
 */
export async function syncGuildChannels(
  db: Firestore,
  client: Client,
  guildId: string,
): Promise<void> {
  const snapshot = await db.collection('botRegistrations')
    .where('guildId', '==', guildId)
    .where('status', '==', 'active')
    .limit(1)
    .get();

  if (snapshot.empty) return;

  const doc = snapshot.docs[0];
  try {
    const channels = await getTextChannels(client, guildId);
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
    logger.warn('Failed to sync channels for guild', {
      guildId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
