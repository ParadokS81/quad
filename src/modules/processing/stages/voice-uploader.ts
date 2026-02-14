/**
 * Voice Uploader — uploads per-map split audio to Firebase Storage
 * and writes a manifest document to Firestore.
 *
 * Called after the fast pipeline (audio-splitter) completes.
 * Best-effort: skips gracefully if Firebase is not configured.
 *
 * Multi-clan (Phase 2):
 *   Registered guilds:  voice-recordings/{teamId}/{demoSha256}/{discordUserId}.ogg
 *   Unregistered:       voice-recordings/{demoSha256}/{playerName}.ogg  (PoC fallback)
 *
 * Firestore doc: /voiceRecordings/{demoSha256}
 */

import { stat } from 'node:fs/promises';
import { logger } from '../../../core/logger.js';
import type { SegmentMetadata, SegmentPlayer } from '../types.js';
import type { BotRegistration } from '../../registration/register.js';

export interface UploadResult {
  uploaded: number;
  skipped: number;
}

interface ResolvedPlayer {
  playerName: string;
  resolved: boolean;
}

/**
 * Resolve player names using registration data.
 *
 * Resolution order:
 *   1. Team roster (team doc → playerRoster → user docs → match discordUserId)
 *   2. knownPlayers map from botRegistration
 *   3. Global user lookup (query users collection by discordUserId — catches standins)
 *   4. Fallback to player.name from audio-splitter (Discord display name)
 */
async function resolvePlayerNames(
  db: FirebaseFirestore.Firestore,
  registration: BotRegistration | null,
  players: SegmentPlayer[],
): Promise<Map<string, ResolvedPlayer>> {
  const result = new Map<string, ResolvedPlayer>();

  if (!registration) {
    // No registration — use audio-splitter names as-is, all unresolved
    for (const p of players) {
      result.set(p.discordUserId || p.discordUsername, {
        playerName: p.name,
        resolved: false,
      });
    }
    return result;
  }

  // Build a Discord ID → QW name lookup from the team roster
  const rosterNames = new Map<string, string>();
  try {
    const teamDoc = await db.collection('teams').doc(registration.teamId).get();
    const teamData = teamDoc.data();
    const roster: Array<{ userId: string }> = teamData?.playerRoster || [];

    if (roster.length > 0) {
      // Read user docs to find their Discord IDs and display names
      const userIds = roster.map(r => r.userId);
      // Firestore getAll supports up to 500 docs — we'll have 4-8 max
      const userRefs = userIds.map(uid => db.collection('users').doc(uid));
      const userDocs = await db.getAll(...userRefs);

      for (const userDoc of userDocs) {
        if (!userDoc.exists) continue;
        const userData = userDoc.data();
        if (userData?.discordUserId && userData?.displayName) {
          rosterNames.set(userData.discordUserId, userData.displayName);
        }
      }
    }
  } catch (err) {
    logger.debug('Roster lookup failed (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Resolve each player
  for (const p of players) {
    const discordId = p.discordUserId;

    // 1. Team roster match
    const rosterName = rosterNames.get(discordId);
    if (rosterName) {
      result.set(discordId, { playerName: rosterName, resolved: true });
      continue;
    }

    // 2. knownPlayers from registration
    const knownName = registration.knownPlayers[discordId];
    if (knownName) {
      result.set(discordId, { playerName: knownName, resolved: true });
      continue;
    }

    // 3. Global user lookup — catches standins from other teams
    // who have MatchScheduler accounts with discordUserId linked
    try {
      const userSnap = await db.collection('users')
        .where('discordUserId', '==', discordId)
        .limit(1)
        .get();

      if (!userSnap.empty) {
        const userData = userSnap.docs[0].data();
        if (userData.displayName) {
          result.set(discordId, { playerName: userData.displayName, resolved: true });
          continue;
        }
      }
    } catch (err) {
      logger.debug('Global user lookup failed (non-fatal)', {
        discordId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // 4. Fallback to audio-splitter name (Discord display name)
    result.set(discordId, { playerName: p.name, resolved: false });
  }

  return result;
}

/**
 * Resolve the visibility setting for a team's voice recordings.
 */
async function resolveVisibility(
  db: FirebaseFirestore.Firestore,
  registration: BotRegistration | null,
): Promise<'public' | 'private'> {
  if (!registration) return 'public'; // backward compat for unregistered guilds

  try {
    const teamDoc = await db.collection('teams').doc(registration.teamId).get();
    const voiceSettings = teamDoc.data()?.voiceSettings;
    return voiceSettings?.defaultVisibility || 'private';
  } catch {
    return 'private';
  }
}

/**
 * Upload voice recordings for all non-intermission segments.
 *
 * @param segments - Segments from the audio-splitter stage
 * @param teamTag - Team tag from session metadata (e.g., "sr") — fallback for unregistered guilds
 * @param guildId - Discord guild ID for registration lookup
 */
export async function uploadVoiceRecordings(
  segments: SegmentMetadata[],
  teamTag: string,
  guildId: string,
): Promise<UploadResult> {
  // Lazy-import Firebase — skip entirely if not configured
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;
  let bucket: any;

  try {
    const firebase = await import('../../standin/firestore.js');
    db = firebase.getDb();
    const b = firebase.getBucket();
    if (!b) {
      logger.info('Voice upload skipped — Storage bucket not initialized');
      return { uploaded: 0, skipped: segments.length };
    }
    bucket = b;
  } catch {
    logger.info('Voice upload skipped — Firebase not configured');
    return { uploaded: 0, skipped: segments.length };
  }

  // Look up registration for this guild
  let registration: BotRegistration | null = null;
  try {
    const { getRegistrationForGuild } = await import('../../registration/register.js');
    registration = await getRegistrationForGuild(guildId);
    if (registration) {
      logger.info('Voice upload using registration', {
        teamId: registration.teamId,
        teamTag: registration.teamTag,
      });
    }
  } catch (err) {
    logger.debug('Registration lookup failed (non-fatal, using fallback)', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Resolve visibility once (same for all segments in this upload)
  const visibility = await resolveVisibility(db, registration);

  // Effective team identity
  const effectiveTeamId = registration?.teamId || '';
  const effectiveTeamTag = registration?.teamTag || teamTag;

  let uploaded = 0;
  let skipped = 0;

  for (const segment of segments) {
    // Skip intermissions — only upload map voice
    if (segment.isIntermission) {
      skipped++;
      continue;
    }

    // Skip segments without a demo SHA256
    if (!segment.demoSha256) {
      logger.warn(`Voice upload: skipping segment ${segment.dirName} — no demoSha256`);
      skipped++;
      continue;
    }

    // Skip segments with no players
    if (!segment.players || segment.players.length === 0) {
      skipped++;
      continue;
    }

    try {
      // Resolve player names for this segment
      const resolvedNames = await resolvePlayerNames(db, registration, segment.players);

      const tracks: Array<{
        discordUserId: string;
        discordUsername: string;
        playerName: string;
        resolved: boolean;
        storagePath: string;
        fileName: string;
        size: number;
        duration: number | null;
      }> = [];

      for (const player of segment.players) {
        const resolved = resolvedNames.get(player.discordUserId || player.discordUsername);
        const playerName = resolved?.playerName || player.name;
        const wasResolved = resolved?.resolved || false;

        // Storage path depends on registration
        let fileName: string;
        let storagePath: string;
        if (registration && player.discordUserId) {
          // Multi-clan: use discordUserId for stable filenames
          fileName = `${player.discordUserId}.ogg`;
          storagePath = `voice-recordings/${effectiveTeamId}/${segment.demoSha256}/${fileName}`;
        } else {
          // Fallback: PoC behavior with playerName
          fileName = `${player.name}.ogg`;
          storagePath = `voice-recordings/${segment.demoSha256}/${fileName}`;
        }

        const localPath = player.audioFile;
        const fileStat = await stat(localPath);

        // Upload to Firebase Storage
        await bucket.upload(localPath, {
          destination: storagePath,
          contentType: 'audio/ogg',
          metadata: {
            metadata: {
              demoSha256: segment.demoSha256,
              map: segment.map,
              player: playerName,
              discordUserId: player.discordUserId || '',
              teamId: effectiveTeamId,
            },
          },
        });

        tracks.push({
          discordUserId: player.discordUserId || '',
          discordUsername: player.discordUsername,
          playerName,
          resolved: wasResolved,
          storagePath,
          fileName,
          size: fileStat.size,
          duration: player.duration || null,
        });
      }

      // Write manifest to Firestore
      await db.collection('voiceRecordings').doc(segment.demoSha256).set({
        demoSha256: segment.demoSha256,
        teamId: effectiveTeamId,
        teamTag: effectiveTeamTag.toLowerCase(),
        visibility,
        source: 'firebase_storage',
        tracks,
        mapName: segment.map,
        recordedAt: new Date(segment.matchData.timestamp),
        uploadedAt: new Date(),
        uploadedBy: 'quad-bot',
        trackCount: tracks.length,
      });

      uploaded++;
      logger.info(`Voice recording uploaded: ${segment.map}`, {
        demoSha256: segment.demoSha256.slice(0, 12) + '…',
        teamId: effectiveTeamId || '(none)',
        tracks: tracks.length,
        resolved: tracks.filter(t => t.resolved).length,
        totalSize: tracks.reduce((sum, t) => sum + t.size, 0),
      });
    } catch (err) {
      logger.error(`Voice upload failed for ${segment.dirName}`, {
        error: err instanceof Error ? err.message : String(err),
        demoSha256: segment.demoSha256?.slice(0, 12),
      });
      skipped++;
    }
  }

  return { uploaded, skipped };
}
