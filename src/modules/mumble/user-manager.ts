/**
 * Mumble user manager — registers team roster members as Mumble users.
 *
 * Called during config activation (after M1 creates the channel).
 * Reads the team roster from Firestore, registers each member via Murmur ICE,
 * sets channel ACLs (deny all, allow members), and writes mumbleUsers to Firestore.
 */

import crypto from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { IceClient, PERM, type ACLEntry } from './ice-client.js';

/** Permissions granted to team members in their channel. */
const MEMBER_PERMS = PERM.Traverse | PERM.Enter | PERM.Speak | PERM.TextMessage;

export interface MumbleUserEntry {
  mumbleUsername: string;
  mumbleUserId: number;
  tempPassword: string | null;
  certificatePinned: boolean;
  linkedAt: null;
}

export class UserManager {
  constructor(
    private readonly iceClient: IceClient,
    private readonly db: Firestore,
  ) {}

  /**
   * Register all team roster members as Mumble users, set channel ACLs,
   * and persist the credentials to `mumbleConfig/{teamId}`.
   *
   * Called after the Mumble channel is created for a team.
   */
  async registerTeamUsers(teamId: string, channelId: number): Promise<void> {
    const teamDoc = await this.db.collection('teams').doc(teamId).get();
    if (!teamDoc.exists) {
      throw new Error(`Team ${teamId} not found in Firestore`);
    }

    const teamData = teamDoc.data()!;
    const roster = (teamData.playerRoster as Array<{ userId: string; displayName: string }>) ?? [];

    if (roster.length === 0) {
      logger.warn(`Team ${teamId} roster is empty — no Mumble users registered`, { teamId });
      return;
    }

    const mumbleUsers: Record<string, MumbleUserEntry> = {};
    const registered: MumbleUserEntry[] = [];

    for (const member of roster) {
      if (!member.userId || !member.displayName) continue;

      const tempPassword = crypto.randomBytes(6).toString('base64url').slice(0, 8);

      let mumbleUserId: number;
      try {
        mumbleUserId = await this.iceClient.registerUser(member.displayName, tempPassword);
      } catch (err) {
        logger.error(`Failed to register Mumble user for ${member.displayName}`, {
          teamId,
          error: String(err),
        });
        continue;
      }

      const entry: MumbleUserEntry = {
        mumbleUsername: member.displayName,
        mumbleUserId,
        tempPassword,
        certificatePinned: false,
        linkedAt: null,
      };

      mumbleUsers[member.userId] = entry;
      registered.push(entry);

      logger.info(`Registered Mumble user: ${member.displayName} (id=${mumbleUserId})`, { teamId });
    }

    if (registered.length === 0) {
      logger.warn(`No Mumble users successfully registered for team ${teamId}`);
      return;
    }

    // Set channel ACL: deny all by default, allow each registered team member
    await this.setTeamChannelACL(channelId, registered);

    // Write all mumbleUsers to Firestore
    await this.db.collection('mumbleConfig').doc(teamId).update({
      mumbleUsers,
      updatedAt: new Date(),
    });

    logger.info(`Team ${teamId}: registered ${registered.length}/${roster.length} Mumble users`, {
      teamId,
      channelId,
    });
  }

  private async setTeamChannelACL(
    channelId: number,
    users: MumbleUserEntry[],
  ): Promise<void> {
    const acls: ACLEntry[] = [
      // Deny @all from entering and speaking, allow traversal so channel is visible
      {
        applyHere: true,
        applySubs: true,
        inherited: false,
        userid: -1,
        group: 'all',
        allow: PERM.Traverse,
        deny: PERM.Enter | PERM.Speak,
      },
      // Allow each registered team member to enter and speak
      ...users.map((u): ACLEntry => ({
        applyHere: true,
        applySubs: false,
        inherited: false,
        userid: u.mumbleUserId,
        group: '',
        allow: MEMBER_PERMS,
        deny: 0,
      })),
    ];

    try {
      // inherit=false: channel uses only these explicit ACLs, not the parent's open permissions
      await this.iceClient.setACL(channelId, acls, false);
      logger.info(`Set channel ACL: ${users.length} members allowed`, { channelId });
    } catch (err) {
      // Non-fatal: log and continue. The channel is still usable; it will be open until
      // the ACL is retried. A future M4 roster sync will re-apply ACLs.
      logger.error(`Failed to set channel ACL for channel ${channelId}`, { error: String(err) });
    }
  }

  /**
   * Add a new user to an existing team channel — called on roster additions (M4).
   */
  async addUserToTeam(
    teamId: string,
    channelId: number,
    userId: string,
    displayName: string,
  ): Promise<MumbleUserEntry> {
    const tempPassword = crypto.randomBytes(6).toString('base64url').slice(0, 8);
    const mumbleUserId = await this.iceClient.registerUser(displayName, tempPassword);

    const entry: MumbleUserEntry = {
      mumbleUsername: displayName,
      mumbleUserId,
      tempPassword,
      certificatePinned: false,
      linkedAt: null,
    };

    await this.db.collection('mumbleConfig').doc(teamId).update({
      [`mumbleUsers.${userId}`]: entry,
      updatedAt: new Date(),
    });

    // Refresh the channel ACL to include the new user
    const configDoc = await this.db.collection('mumbleConfig').doc(teamId).get();
    const allUsers = Object.values(
      (configDoc.data()?.mumbleUsers ?? {}) as Record<string, MumbleUserEntry>,
    );
    await this.setTeamChannelACL(channelId, allUsers);

    logger.info(`Added Mumble user ${displayName} (id=${mumbleUserId}) to team ${teamId}`);
    return entry;
  }

  /** Unregister a Mumble user by their Murmur user ID (direct ICE call). */
  async unregisterUser(mumbleUserId: number): Promise<void> {
    await this.iceClient.unregisterUser(mumbleUserId);
  }

  /**
   * Remove a user from a team channel — called on roster removals (M4).
   */
  async removeUserFromTeam(
    teamId: string,
    channelId: number,
    userId: string,
    mumbleUserId: number,
  ): Promise<void> {
    await this.iceClient.unregisterUser(mumbleUserId);

    const { FieldValue } = await import('firebase-admin/firestore');
    await this.db.collection('mumbleConfig').doc(teamId).update({
      [`mumbleUsers.${userId}`]: FieldValue.delete(),
      updatedAt: new Date(),
    });

    // Refresh channel ACL
    const configDoc = await this.db.collection('mumbleConfig').doc(teamId).get();
    const allUsers = Object.values(
      (configDoc.data()?.mumbleUsers ?? {}) as Record<string, MumbleUserEntry>,
    );
    await this.setTeamChannelACL(channelId, allUsers);

    logger.info(`Removed Mumble user ${mumbleUserId} from team ${teamId}`);
  }
}
