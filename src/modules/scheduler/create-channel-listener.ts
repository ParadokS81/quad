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

let unsubscribe: (() => void) | null = null;

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
          handleCreateChannelRequest(db, change.doc, client).catch((err) => {
            logger.error('Create channel request handler failed', {
              docId: change.doc.id,
              error: err instanceof Error ? err.message : String(err),
            });
          });
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
    const me = guild.members.me;

    if (!me) {
      throw new Error('Bot member not found in guild');
    }

    // Create a text channel: everyone can read, only bot can write
    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      permissionOverwrites: [
        {
          id: guild.roles.everyone.id,
          deny: [PermissionFlagsBits.SendMessages],
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
      ],
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
