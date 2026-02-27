/**
 * Mumble roster sync — processes pendingSync events on mumbleConfig docs.
 *
 * MatchScheduler CF writes `pendingSync` when a team roster changes (add/remove/rename).
 * This module reads the event, applies the change to Mumble and Firestore, then clears
 * the pendingSync field.
 *
 * M4: Roster Sync
 */

import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { IceClient } from './ice-client.js';
import { UserManager, type MumbleUserEntry } from './user-manager.js';

interface PendingSync {
  action: 'add' | 'remove' | 'rename';
  userId: string;
  displayName: string;
  oldDisplayName?: string;
  discordUserId?: string;
  timestamp: Timestamp;
}

interface MumbleConfig {
  teamId: string;
  channelId: number;
  mumbleUsers?: Record<string, MumbleUserEntry>;
}

export class RosterSync {
  constructor(
    private readonly iceClient: IceClient,
    private readonly userManager: UserManager,
    private readonly db: Firestore,
  ) {}

  async handleSync(teamId: string, sync: PendingSync, config: MumbleConfig): Promise<void> {
    logger.info(`Roster sync: action=${sync.action} user=${sync.userId} name=${sync.displayName}`, { teamId });

    try {
      switch (sync.action) {
        case 'add':
          await this.handleAdd(teamId, sync, config);
          break;
        case 'remove':
          await this.handleRemove(teamId, sync, config);
          break;
        case 'rename':
          await this.handleRename(teamId, sync, config);
          break;
        default:
          logger.warn(`Unknown pendingSync action: ${(sync as PendingSync).action}`, { teamId });
      }
    } catch (err) {
      logger.error(`Roster sync failed: action=${sync.action} user=${sync.userId}`, {
        teamId,
        error: String(err),
      });
      // Clear pendingSync even on error to avoid infinite retry loops.
      // The error is logged; manual remediation can be done via Mumble admin.
    }

    // Always clear pendingSync after processing (success or failure)
    const { FieldValue } = await import('firebase-admin/firestore');
    await this.db.collection('mumbleConfig').doc(teamId).update({
      pendingSync: FieldValue.delete(),
      updatedAt: new Date(),
    });
  }

  private async handleAdd(
    teamId: string,
    sync: PendingSync,
    config: MumbleConfig,
  ): Promise<void> {
    const entry = await this.userManager.addUserToTeam(
      teamId,
      config.channelId,
      sync.userId,
      sync.displayName,
    );
    logger.info(`Added Mumble user ${sync.displayName} (id=${entry.mumbleUserId}) for team ${teamId}`);
  }

  private async handleRemove(
    teamId: string,
    sync: PendingSync,
    config: MumbleConfig,
  ): Promise<void> {
    const userEntry = config.mumbleUsers?.[sync.userId];
    if (!userEntry) {
      logger.warn(`Remove sync: no mumbleUsers entry for userId=${sync.userId}`, { teamId });
      return;
    }

    await this.userManager.removeUserFromTeam(
      teamId,
      config.channelId,
      sync.userId,
      userEntry.mumbleUserId,
    );

    // Clear mumbleLinked on the user profile
    try {
      const { FieldValue } = await import('firebase-admin/firestore');
      await this.db.collection('users').doc(sync.userId).update({
        mumbleLinked: FieldValue.delete(),
        mumbleUsername: FieldValue.delete(),
        mumbleLinkedAt: FieldValue.delete(),
      });
    } catch (err) {
      // Non-fatal: the Mumble user is removed; profile cleanup failure is minor
      logger.warn(`Failed to clear mumbleLinked for user ${sync.userId}`, { error: String(err) });
    }

    logger.info(`Removed Mumble user ${userEntry.mumbleUserId} for team ${teamId}`);
  }

  private async handleRename(
    teamId: string,
    sync: PendingSync,
    config: MumbleConfig,
  ): Promise<void> {
    const userEntry = config.mumbleUsers?.[sync.userId];
    if (!userEntry) {
      logger.warn(`Rename sync: no mumbleUsers entry for userId=${sync.userId}`, { teamId });
      return;
    }

    // 1. Update Mumble registration
    await this.iceClient.updateRegistration(userEntry.mumbleUserId, {
      username: sync.displayName,
    });

    // 2. Update mumbleConfig.mumbleUsers entry
    await this.db.collection('mumbleConfig').doc(teamId).update({
      [`mumbleUsers.${sync.userId}.mumbleUsername`]: sync.displayName,
      updatedAt: new Date(),
    });

    // 3. Update user profile
    try {
      await this.db.collection('users').doc(sync.userId).update({
        mumbleUsername: sync.displayName,
      });
    } catch (err) {
      logger.warn(`Failed to update mumbleUsername on user profile for ${sync.userId}`, {
        error: String(err),
      });
    }

    logger.info(
      `Renamed Mumble user ${userEntry.mumbleUserId}: ${sync.oldDisplayName ?? '?'} → ${sync.displayName}`,
      { teamId },
    );
  }
}
