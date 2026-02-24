/**
 * Listens for channel creation requests from MatchScheduler.
 * When a team leader clicks "Create Channel", the Cloud Function writes
 * createChannelRequest.status = 'pending' on their botRegistrations doc.
 * We pick that up, create a read-only text channel, and write back the channel ID.
 */

import { type Client, ChannelType, PermissionFlagsBits } from 'discord.js';
import { type Firestore, FieldValue } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { syncGuildChannels } from './channels.js';
import { startTeamListener } from '../availability/listener.js';

let unsubscribe: (() => void) | null = null;
const processing = new Set<string>(); // Guard against duplicate handling

/**
 * Start listening for channel creation requests.
 */
export function startCreateChannelListener(db: Firestore, client: Client): void {
  const query = db.collection('botRegistrations')
    .where('createChannelRequest.status', '==', 'pending');

  unsubscribe = query.onSnapshot(
    (snapshot) => {
      for (const change of snapshot.docChanges()) {
        if (change.type === 'added' || change.type === 'modified') {
          const docId = change.doc.id;
          if (processing.has(docId)) continue;
          processing.add(docId);
          handleCreateChannelRequest(db, change.doc, client)
            .catch((err) => {
              logger.error('Create channel request handler failed', {
                docId,
                error: err instanceof Error ? err.message : String(err),
              });
            })
            .finally(() => processing.delete(docId));
        }
      }
    },
    (err) => {
      logger.error('Create channel listener error', {
        error: err instanceof Error ? err.message : String(err),
      });
    },
  );

  logger.info('Create channel request listener started');
}

/**
 * Stop the create channel listener.
 */
export function stopCreateChannelListener(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
    logger.info('Create channel request listener stopped');
  }
}

/**
 * Handle a single channel creation request:
 * create a read-only text channel, write back the ID, re-sync channels.
 */
async function handleCreateChannelRequest(
  db: Firestore,
  doc: FirebaseFirestore.QueryDocumentSnapshot,
  client: Client,
): Promise<void> {
  const data = doc.data();
  const guildId = data.guildId as string | undefined;
  const request = data.createChannelRequest as {
    channelName: string;
    requestedBy: string;
    status: string;
  } | undefined;

  if (!guildId || !request || request.status !== 'pending') return;

  const channelName = request.channelName || 'schedule';

  logger.info('Processing create channel request', {
    docId: doc.id,
    teamId: data.teamId,
    guildId,
    channelName,
  });

  try {
    const guild = await client.guilds.fetch(guildId);
    const channels = await guild.channels.fetch();
    const me = guild.members.me;

    if (!me) {
      throw new Error('Bot member not found in guild');
    }

    // Find the category that most text channels live in (if any)
    const textChannels = channels.filter(ch => ch !== null && ch.type === ChannelType.GuildText);
    const parentCounts = new Map<string | null, number>();
    for (const [, ch] of textChannels) {
      const pid = ch!.parentId;
      parentCounts.set(pid, (parentCounts.get(pid) ?? 0) + 1);
    }
    // Pick the most common parent (excluding null/uncategorized)
    let bestParent: string | null = null;
    let bestCount = 0;
    for (const [pid, count] of parentCounts) {
      if (pid !== null && count > bestCount) {
        bestParent = pid;
        bestCount = count;
      }
    }

    // Log bot's guild-level permissions for diagnostics
    const guildPerms = me.permissions;
    logger.info('Bot guild permissions', {
      guildId,
      manageChannels: guildPerms.has(PermissionFlagsBits.ManageChannels),
      manageRoles: guildPerms.has(PermissionFlagsBits.ManageRoles),
      sendMessages: guildPerms.has(PermissionFlagsBits.SendMessages),
      embedLinks: guildPerms.has(PermissionFlagsBits.EmbedLinks),
      attachFiles: guildPerms.has(PermissionFlagsBits.AttachFiles),
    });

    // Create a text channel: everyone can read, only bot can write.
    // We build permission overwrites that deny SendMessages for @everyone
    // AND for any role that has SendMessages allowed in the parent category,
    // so category-level role overrides don't leak through.
    const denyMessagesPerms = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.SendMessagesInThreads, PermissionFlagsBits.CreatePublicThreads, PermissionFlagsBits.CreatePrivateThreads];
    const permissionOverwrites: Array<{ id: string; deny?: bigint[]; allow?: bigint[] }> = [
      {
        id: guild.roles.everyone.id,
        deny: denyMessagesPerms,
        allow: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: me.id,
        allow: [
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.AttachFiles,
        ],
      },
    ];

    // If placing under a category, check for roles that have SendMessages
    // allowed at the category level — we must explicitly deny them on the
    // channel, otherwise they override the @everyone deny.
    if (bestParent) {
      const parentChannel = channels.get(bestParent);
      if (parentChannel && 'permissionOverwrites' in parentChannel) {
        for (const [overwriteId, overwrite] of parentChannel.permissionOverwrites.cache) {
          // Skip @everyone (already handled) and the bot itself
          if (overwriteId === guild.roles.everyone.id || overwriteId === me.id) continue;
          if (overwrite.allow.has(PermissionFlagsBits.SendMessages)) {
            permissionOverwrites.push({
              id: overwriteId,
              deny: denyMessagesPerms,
            });
          }
        }
      }
    }

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: bestParent ?? undefined,
      permissionOverwrites,
    });

    logger.info('Created schedule channel', {
      guildId,
      channelId: channel.id,
      channelName: channel.name,
    });

    // Write back the channel ID and clear the request
    await doc.ref.update({
      scheduleChannelId: channel.id,
      scheduleChannelName: channel.name,
      createChannelRequest: FieldValue.delete(),
      updatedAt: new Date(),
    });

    // Re-sync available channels so the dropdown includes the new one
    await syncGuildChannels(db, client, guildId);

    // Start the availability listener so the grid gets posted immediately
    const teamId = doc.id;
    try {
      await startTeamListener(teamId, channel.id, null);
      logger.info('Started availability listener for new schedule channel', { teamId, channelId: channel.id });
    } catch (listenerErr) {
      logger.warn('Failed to start availability listener after channel creation', {
        teamId,
        error: listenerErr instanceof Error ? listenerErr.message : String(listenerErr),
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to create schedule channel', {
      docId: doc.id,
      guildId,
      error: errorMsg,
    });

    // Mark request as failed so the UI can show an error
    await doc.ref.update({
      'createChannelRequest.status': 'failed',
      'createChannelRequest.error': errorMsg,
      updatedAt: new Date(),
    });
  }
}
