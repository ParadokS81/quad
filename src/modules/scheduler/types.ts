/**
 * Scheduler notification types — mirrors the Firestore `notifications` collection schema.
 */

import type { Timestamp } from 'firebase-admin/firestore';

export interface ConfirmedSlot {
  slotId: string;
  proposerCount: number;
  opponentCount: number;
}

export interface DeliveryTarget {
  botRegistered: boolean;
  notificationsEnabled: boolean;
  channelId: string | null;
  guildId: string | null;
}

export interface OpponentDeliveryTarget extends DeliveryTarget {
  leaderDiscordId: string | null;
  leaderDisplayName: string | null;
}

export interface ChallengeNotification {
  type: 'challenge_proposed';
  status: 'pending' | 'delivered' | 'failed';
  proposalId: string;
  createdBy: string;
  proposerTeamId: string;
  proposerTeamName: string;
  proposerTeamTag: string;
  opponentTeamId: string;
  opponentTeamName: string;
  opponentTeamTag: string;
  weekId: string;
  gameType: 'official' | 'practice';
  confirmedSlots: ConfirmedSlot[];
  delivery: {
    opponent: OpponentDeliveryTarget;
    proposer: DeliveryTarget;
  };
  proposalUrl: string;
  proposerLeaderDiscordId: string | null;
  proposerLeaderDisplayName: string | null;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
  deliveryResult?: {
    opponentChannelSent: boolean;
    opponentDmSent: boolean;
    proposerChannelSent: boolean;
    error?: string;
  };
}
