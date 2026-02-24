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
  proposerLogoUrl: string | null;
  opponentTeamId: string;
  opponentTeamName: string;
  opponentTeamTag: string;
  opponentLogoUrl: string | null;
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

export interface SlotConfirmedNotification {
  type: 'slot_confirmed';
  status: 'pending' | 'delivered' | 'failed';
  proposalId: string;
  slotId: string;
  gameType: 'official' | 'practice';
  weekId: string;
  proposalUrl: string;
  proposerLogoUrl: string | null;
  opponentLogoUrl: string | null;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
  // Who confirmed
  confirmedByTeamId: string;
  confirmedByTeamName: string;
  confirmedByTeamTag: string;
  confirmedByUserId: string;
  confirmedByDisplayName: string | null;
  confirmedByDiscordId: string | null;
  // For logo side determination
  proposerTeamId: string;
  // Who receives this notification
  recipientTeamId: string;
  recipientTeamName: string;
  recipientTeamTag: string;
  // Single delivery target (the recipient)
  delivery: {
    botRegistered: boolean;
    notificationsEnabled: boolean;
    channelId: string | null;
    guildId: string | null;
    leaderDiscordId: string | null;
    leaderDisplayName: string | null;
  };
  deliveryResult?: {
    channelSent: boolean;
    dmSent: boolean;
    error?: string;
  };
}

export interface MatchSealedNotification {
  type: 'match_sealed';
  status: 'pending' | 'delivered' | 'failed';
  proposalId: string;
  scheduledMatchId: string;
  slotId: string;
  gameType: 'official' | 'practice';
  weekId: string;
  proposalUrl: string;
  proposerLogoUrl: string | null;
  opponentLogoUrl: string | null;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
  proposerTeamId: string;
  proposerTeamName: string;
  proposerTeamTag: string;
  opponentTeamId: string;
  opponentTeamName: string;
  opponentTeamTag: string;
  // Who receives this particular notification doc
  recipientTeamId: string;
  recipientTeamName: string;
  recipientTeamTag: string;
  // Single delivery target
  delivery: {
    botRegistered: boolean;
    notificationsEnabled: boolean;
    channelId: string | null;
    guildId: string | null;
  };
  deliveryResult?: {
    channelSent: boolean;
    error?: string;
  };
}

export interface ProposalCancelledNotification {
  type: 'proposal_cancelled';
  status: 'pending' | 'delivered' | 'failed';
  proposalId: string;
  proposerTeamId: string;
  opponentTeamId: string;
  cancelledBy: string;
  createdAt: Timestamp;
  deliveredAt: Timestamp | null;
}

export type SchedulerNotification =
  | ChallengeNotification
  | SlotConfirmedNotification
  | MatchSealedNotification
  | ProposalCancelledNotification;
