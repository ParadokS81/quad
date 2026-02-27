/**
 * Mumble session monitor — detects first-time user connections and pins certificates.
 *
 * How cert pinning works in Mumble:
 *   1. User connects with username + temp password → Murmur authenticates them
 *   2. Murmur stores the user's self-generated certificate hash with their account
 *   3. Future connections: certificate alone identifies the user, no password needed
 *
 * Detection:
 *   We listen to the `userCreate` event from the @tf2pickup-org/mumble-client
 *   protocol connection (already established in M1). When a user with a registered
 *   Murmur user ID appears, we check if their cert was previously unlinked, and if
 *   so, mark it as pinned and update their profile.
 *
 * This avoids implementing full ICE callbacks (which require running an ICE server
 * adapter in the sidecar) — the protocol client events give us the same signal.
 */

import type { Firestore } from 'firebase-admin/firestore';
import type { Client as MumbleClient, User } from '@tf2pickup-org/mumble-client';
import { logger } from '../../core/logger.js';

interface CachedUserEntry {
  userId: string;             // MatchScheduler Firebase UID
  mumbleUserId: number;       // Murmur internal user ID
  mumbleUsername: string;
  certificatePinned: boolean;
}

interface TeamConfigCache {
  teamId: string;
  users: Map<number, CachedUserEntry>; // keyed by mumbleUserId
}

export class SessionMonitor {
  private db: Firestore | null = null;
  private teamConfigs = new Map<string, TeamConfigCache>(); // keyed by teamId
  private unsubscribeSnapshot: (() => void) | null = null;

  /**
   * Start monitoring Mumble connections.
   *
   * @param db            Firestore instance for reading/writing mumbleConfig
   * @param mumbleClient  The protocol client from M1 (already connected)
   */
  start(db: Firestore, mumbleClient: MumbleClient): void {
    this.db = db;

    // Hook into the protocol client's user events
    mumbleClient.on('userCreate', (user: User) => {
      this.onUserConnect(user).catch(err => {
        logger.error('SessionMonitor: unhandled error on userCreate', { error: String(err) });
      });
    });

    // Load and watch active team configs
    this.watchConfigs(db);

    logger.info('SessionMonitor started');
  }

  stop(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;
    this.teamConfigs.clear();
    this.db = null;
  }

  /** Called when a new user appears on the Mumble server. */
  private async onUserConnect(user: User): Promise<void> {
    // userId is undefined for anonymous (unregistered) users
    if (!user.isRegistered || user.userId === undefined) return;

    const mumbleUserId = user.userId;
    const entry = this.findEntry(mumbleUserId);
    if (!entry) return; // Unknown user — not one of ours

    if (entry.certificatePinned) return; // Already done

    await this.pinCertificate(entry.teamId, entry.userId, entry.mumbleUsername, mumbleUserId);
  }

  /**
   * Find which team + Firebase user a Murmur user ID belongs to.
   * Returns null if not found in any active config.
   */
  private findEntry(mumbleUserId: number): (CachedUserEntry & { teamId: string }) | null {
    for (const [teamId, config] of this.teamConfigs) {
      const entry = config.users.get(mumbleUserId);
      if (entry) return { ...entry, teamId };
    }
    return null;
  }

  /**
   * Mark the certificate as pinned, clear the temp password, and update
   * both the mumbleConfig doc and the user's profile.
   */
  private async pinCertificate(
    teamId: string,
    userId: string,
    mumbleUsername: string,
    mumbleUserId: number,
  ): Promise<void> {
    if (!this.db) return;

    const now = new Date();

    await this.db.collection('mumbleConfig').doc(teamId).update({
      [`mumbleUsers.${userId}.certificatePinned`]: true,
      [`mumbleUsers.${userId}.tempPassword`]: null,
      [`mumbleUsers.${userId}.linkedAt`]: now,
      updatedAt: now,
    });

    await this.db.collection('users').doc(userId).set(
      {
        mumbleLinked: true,
        mumbleUsername,
        mumbleLinkedAt: now,
      },
      { merge: true },
    );

    // Update local cache so repeated connects don't re-fire
    const config = this.teamConfigs.get(teamId);
    if (config) {
      const entry = config.users.get(mumbleUserId);
      if (entry) entry.certificatePinned = true;
    }

    logger.info(`Certificate pinned for ${mumbleUsername} (team ${teamId}, user ${userId})`);
  }

  /** Subscribe to mumbleConfig changes and keep the local cache in sync. */
  private watchConfigs(db: Firestore): void {
    this.unsubscribeSnapshot = db.collection('mumbleConfig')
      .where('status', '==', 'active')
      .onSnapshot(
        snapshot => {
          for (const change of snapshot.docChanges()) {
            const teamId = change.doc.id;

            if (change.type === 'removed') {
              this.teamConfigs.delete(teamId);
              continue;
            }

            const data = change.doc.data();
            const mumbleUsers = (data.mumbleUsers ?? {}) as Record<string, {
              mumbleUserId: number;
              mumbleUsername: string;
              certificatePinned: boolean;
            }>;

            const users = new Map<number, CachedUserEntry>();
            for (const [userId, entry] of Object.entries(mumbleUsers)) {
              users.set(entry.mumbleUserId, {
                userId,
                mumbleUserId: entry.mumbleUserId,
                mumbleUsername: entry.mumbleUsername,
                certificatePinned: entry.certificatePinned,
              });
            }

            this.teamConfigs.set(teamId, { teamId, users });
          }
        },
        err => logger.error('SessionMonitor: config snapshot error', { error: String(err) }),
      );
  }
}
