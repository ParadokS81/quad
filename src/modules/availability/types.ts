export interface ResolvedUser {
    uid: string;            // Firebase UID
    displayName: string;
    initials: string;       // e.g. "PR" for ParadokS
}

export interface AvailabilityData {
    teamId: string;
    weekId: string;         // "YYYY-WW" e.g. "2026-08"
    slots: Record<string, string[]>;        // UTC slotId → userId[]
    unavailable?: Record<string, string[]>; // UTC slotId → userId[]
}

export interface TeamInfo {
    teamId: string;
    teamTag: string;
    teamName: string;
    logoUrl: string | null;                 // activeLogo.urls.small from Firestore
    roster: Record<string, RosterMember>;   // userId → member info
}

export interface RosterMember {
    displayName: string;
    initials: string;
    discordUserId?: string;
}

export interface ScheduleChannelConfig {
    channelId: string;
    messageId: string | null;   // null until first message posted
}

/** Enriched match data for canvas rendering. */
export interface ScheduledMatchDisplay {
    slotId: string;
    opponentTag: string;
    opponentId: string;
    opponentName: string;
    gameType: 'official' | 'practice';
    opponentLogoUrl: string | null;
    scheduledDate: string;       // pre-formatted "Sun 22nd 21:30 CET"
}

/** Enriched proposal data for canvas rendering. */
export interface ActiveProposalDisplay {
    proposalId: string;          // Firestore doc ID for deep-linking
    opponentTag: string;
    opponentName: string;
    gameType: 'official' | 'practice';
    viableSlots: number;
    opponentLogoUrl: string | null;
    isIncoming: boolean;         // true = someone challenged us, false = we sent it
}
