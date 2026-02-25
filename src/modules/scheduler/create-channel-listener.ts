/**
 * Listens for channel creation requests from MatchScheduler.
 * When a team leader clicks "Create Channel", the Cloud Function writes
 * createChannelRequest.status = 'pending' on their botRegistrations doc.
 * We pick that up, create a read-only text channel, and write back the channel ID.
 */

import { type Client, type Guild, type TextChannel, ChannelType, PermissionFlagsBits } from 'discord.js';
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
 * Create a read-only schedule text channel in a guild.
 * Everyone can read, only the bot can write. Handles category detection
 * and category-level role overrides that could leak SendMessages.
 *
 * Reused by both the Firestore-triggered creation flow and the /register button.
 */
export async function createScheduleChannel(
  guild: Guild,
  channelName: string = 'schedule',
): Promise<TextChannel> {
  const channels = await guild.channels.fetch();
  const me = guild.members.me;

  if (!me) {
    throw new Error('Bot member not found in guild');
  }

  // If a channel with this name already exists, prefix with team-related context
  const nameExists = channels.some(
    ch => ch !== null && ch.type === ChannelType.GuildText && ch.name === channelName,
  );
  const finalName = nameExists ? `${guild.name.toLowerCase().replace(/[^a-z0-9]/g, '')}-${channelName}` : channelName;

  // Find the category that most text channels live in (if any)
  const textChannels = channels.filter(ch => ch !== null && ch.type === ChannelType.GuildText);
  const parentCounts = new Map<string | null, number>();
  for (const [, ch] of textChannels) {
    const pid = ch!.parentId;
    parentCounts.set(pid, (parentCounts.get(pid) ?? 0) + 1);
  }
  let bestParent: string | null = null;
  let bestCount = 0;
  for (const [pid, count] of parentCounts) {
    if (pid !== null && count > bestCount) {
      bestParent = pid;
      bestCount = count;
    }
  }

  logger.info('Bot guild permissions', {
    guildId: guild.id,
    manageChannels: me.permissions.has(PermissionFlagsBits.ManageChannels),
    manageRoles: me.permissions.has(PermissionFlagsBits.ManageRoles),
    sendMessages: me.permissions.has(PermissionFlagsBits.SendMessages),
    embedLinks: me.permissions.has(PermissionFlagsBits.EmbedLinks),
    attachFiles: me.permissions.has(PermissionFlagsBits.AttachFiles),
  });

  // Read-only channel: deny messaging for @everyone, allow for bot.
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

  // Deny messaging for category-level roles that allow SendMessages
  if (bestParent) {
    const parentChannel = channels.get(bestParent);
    if (parentChannel && 'permissionOverwrites' in parentChannel) {
      for (const [overwriteId, overwrite] of parentChannel.permissionOverwrites.cache) {
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
    name: finalName,
    type: ChannelType.GuildText,
    parent: bestParent ?? undefined,
    permissionOverwrites,
  });

  logger.info('Created schedule channel', {
    guildId: guild.id,
    channelId: channel.id,
    channelName: channel.name,
  });

  return channel;
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
    const channel = await createScheduleChannel(guild, channelName);

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
