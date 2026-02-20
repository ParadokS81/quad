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
    roster: Record<string, RosterMember>;   // userId → member info
}

export interface RosterMember {
    displayName: string;
    initials: string;
}

export interface ScheduleChannelConfig {
    channelId: string;
    messageId: string | null;   // null until first message posted
}
