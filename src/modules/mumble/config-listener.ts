import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { MumbleManager } from './mumble-manager.js';
import { UserManager } from './user-manager.js';
import { RosterSync } from './roster-sync.js';

export class MumbleConfigListener {
  private unsubscribePending: (() => void) | null = null;
  private unsubscribeDisabling: (() => void) | null = null;
  private unsubscribeActive: (() => void) | null = null;

  constructor(
    private readonly mumbleManager: MumbleManager,
    private readonly userManager: UserManager | null = null,
    private readonly rosterSync: RosterSync | null = null,
  ) {}

  start(db: Firestore): void {
    // Watch for pending configs (team leader just enabled Mumble)
    this.unsubscribePending = db.collection('mumbleConfig')
      .where('status', '==', 'pending')
      .onSnapshot(
        snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'added') {
              this.handlePendingConfig(change.doc).catch(err => {
                logger.error('Unhandled error in handlePendingConfig', { error: String(err) });
              });
            }
          }
        },
        err => logger.error('mumbleConfig pending listener error', { error: String(err) }),
      );

    // Watch for disabling configs (team leader disabled Mumble)
    this.unsubscribeDisabling = db.collection('mumbleConfig')
      .where('status', '==', 'disabling')
      .onSnapshot(
        snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'added') {
              this.handleDisablingConfig(change.doc).catch(err => {
                logger.error('Unhandled error in handleDisablingConfig', { error: String(err) });
              });
            }
          }
        },
        err => logger.error('mumbleConfig disabling listener error', { error: String(err) }),
      );

    // Watch active configs for pendingSync roster changes (M4)
    if (this.rosterSync) {
      this.unsubscribeActive = db.collection('mumbleConfig')
        .where('status', '==', 'active')
        .onSnapshot(
          snapshot => {
            for (const change of snapshot.docChanges()) {
              if (change.type === 'modified') {
                const data = change.doc.data();
                if (data.pendingSync) {
                  this.rosterSync!.handleSync(data.teamId, data.pendingSync, data as Parameters<RosterSync['handleSync']>[2]).catch(err => {
                    logger.error('Unhandled error in roster handleSync', { error: String(err) });
                  });
                }
              }
            }
          },
          err => logger.error('mumbleConfig active listener error', { error: String(err) }),
        );
    }

    logger.info('Mumble config listener started');
  }

  private async handlePendingConfig(
    doc: FirebaseFirestore.DocumentSnapshot,
  ): Promise<void> {
    const data = doc.data()!;
    const { teamId, teamTag, teamName } = data as {
      teamId: string;
      teamTag: string;
      teamName: string;
    };

    try {
      // M1: Create the Mumble channel
      const channel = await this.mumbleManager.createTeamChannel(teamTag, teamName);

      // M2: Register all team roster members and set channel ACLs
      if (this.userManager) {
        try {
          await this.userManager.registerTeamUsers(teamId, channel.channelId);
        } catch (err) {
          // Log but don't fail the whole activation — the channel exists,
          // users can be registered manually or via a retry.
          logger.error(`User registration failed for team ${teamTag} — channel created but users not set up`, {
            error: String(err),
          });
        }
      }

      await doc.ref.update({
        channelId: channel.channelId,
        channelName: channel.channelName,
        channelPath: channel.channelPath,
        serverAddress: process.env.MUMBLE_HOST || '83.172.66.214',
        serverPort: parseInt(process.env.MUMBLE_PORT || '64738', 10),
        status: 'active',
        activatedAt: new Date(),
        updatedAt: new Date(),
      });

      logger.info(`Mumble channel activated for team ${teamTag}: ${channel.channelPath}`, { teamId });
    } catch (error) {
      await doc.ref.update({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      });
      logger.error(`Failed to activate Mumble for team ${teamTag}`, { error: String(error) });
    }
  }

  private async handleDisablingConfig(
    doc: FirebaseFirestore.DocumentSnapshot,
  ): Promise<void> {
    const data = doc.data()!;
    const { teamTag, channelId, mumbleUsers } = data as {
      teamTag: string;
      channelId?: number;
      mumbleUsers?: Record<string, { mumbleUserId: number }>;
    };

    try {
      // Unregister all Mumble users before deleting the channel
      if (this.userManager && mumbleUsers) {
        for (const entry of Object.values(mumbleUsers)) {
          try {
            await this.userManager.unregisterUser(entry.mumbleUserId);
          } catch (err) {
            logger.warn(`Failed to unregister Mumble user ${entry.mumbleUserId}`, {
              error: String(err),
            });
          }
        }
      }

      if (channelId !== undefined) {
        await this.mumbleManager.deleteTeamChannel(channelId);
      }

      await doc.ref.delete();
      logger.info(`Mumble channel disabled and removed for team ${teamTag}`);
    } catch (error) {
      await doc.ref.update({
        status: 'error',
        errorMessage: error instanceof Error ? error.message : String(error),
        updatedAt: new Date(),
      });
      logger.error(`Failed to disable Mumble channel for ${teamTag}`, { error: String(error) });
    }
  }

  stop(): void {
    this.unsubscribePending?.();
    this.unsubscribePending = null;
    this.unsubscribeDisabling?.();
    this.unsubscribeDisabling = null;
    this.unsubscribeActive?.();
    this.unsubscribeActive = null;
  }
}
