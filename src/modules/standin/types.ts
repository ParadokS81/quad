/**
 * Standin module types — mirrors the Firestore schema from docs/standin-flow/design.md
 */

import type { Timestamp } from 'firebase-admin/firestore';

// -- Standin Request --

export type StandinRequestStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type CandidateResponseStatus = 'pending' | 'accepted' | 'declined';

export interface StandinRequestedBy {
  firebaseUid: string;
  displayName: string;
  teamId: string;
  teamName: string;
  teamTag: string;
  teamLogoUrl?: string;
}

export interface StandinMatch {
  weekId: string;
  slotIds: string[];
  displayTime: string;
  division: string;
  opponent?: string;
}

export interface StandinCandidate {
  firebaseUid: string;
  displayName: string;
  teamName: string;
}

export interface CandidateResponse {
  status: CandidateResponseStatus;
  respondedAt?: Timestamp;
  dmDelivered: boolean;
  dmError?: string;
}

export interface StandinRequest {
  requestId: string;
  status: StandinRequestStatus;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  requestedBy: StandinRequestedBy;
  match: StandinMatch;
  candidates: Record<string, StandinCandidate>;   // keyed by Discord user ID
  responses: Record<string, CandidateResponse>;    // keyed by Discord user ID
  confirmedDiscordId?: string;
  confirmedAt?: Timestamp;
}

// -- Standin Preferences --

export interface StandinPreferences {
  discordUserId: string;
  discordUsername: string;
  optedOut: boolean;
  blockedUsers: string[];       // Firebase UIDs
  blockedTeams: string[];       // team doc IDs
  blockedDivisions: string[];   // e.g. ["D2", "D3"]
  updatedAt: Timestamp;
}
