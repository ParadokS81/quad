/**
 * Match pairer — pairs QW Hub matches to positions in a recording session.
 * Calculates audio offsets, confidence scores, and validates no overlaps.
 *
 * Ported from voice-analysis/src/processing/match_pairer.py
 */

import { logger } from '../../../core/logger.js';
import type { HubMatch, HubTeam, KtxStats, MatchPairing, SessionMetadata } from '../types.js';

const DEFAULT_MATCH_LENGTH = 1210; // 10s countdown + 20min gameplay
const MAX_SESSION_HOURS = 4;
const MIN_PLAYER_OVERLAP = 2; // Minimum QW player names that must match for a "mix" game

/** Strip QW decorations and Discord punctuation for name comparison.
 *  Hub names have bullets ("• razor"), team prefixes, etc.
 *  Discord names may have dots (".andeh"), underscores, brackets. */
function normalizeName(name: string): string {
  return name.replace(/^[^a-zA-Z0-9]+/, '').replace(/[^a-zA-Z0-9]+$/, '').toLowerCase();
}

export interface PairMatchesOptions {
  defaultDuration?: number;
  /** Team tag to filter matches (e.g., "]sr["). Primary filter. */
  teamTag?: string;
  /** Discord ID → QW name mapping from bot registration. Used for player-based filtering. */
  knownPlayers?: Record<string, string>;
}

/**
 * Pair QW Hub matches to positions in the recording.
 *
 * Filtering strategy:
 * 1. If teamTag or knownPlayers are provided, only keep matches where:
 *    - A team name matches the team tag (case-insensitive), OR
 *    - At least MIN_PLAYER_OVERLAP resolved QW names appear in the match players
 * 2. Matches that pass neither filter are discarded (not our matches).
 * 3. Remaining matches get precise audio offsets from timestamps.
 *
 * @param session Recording session metadata
 * @param hubMatches Matches from QW Hub API
 * @param ktxstatsMap Map of demo_sha256 -> KtxStats
 * @param options Pairing options (team tag, known players, default duration)
 * @returns Pairings sorted by audio offset, trimmed for overlaps
 */
export function pairMatches(
  session: SessionMetadata,
  hubMatches: HubMatch[],
  ktxstatsMap?: Map<string, KtxStats>,
  options?: PairMatchesOptions,
): MatchPairing[] {
  const defaultMatchLength = options?.defaultDuration ?? DEFAULT_MATCH_LENGTH;
  const statsMap = ktxstatsMap ?? new Map<string, KtxStats>();
  const teamTag = options?.teamTag?.toLowerCase() ?? '';
  const knownPlayers = options?.knownPlayers ?? {};

  // Resolve recording tracks to QW names.
  // Mumble source: username IS the QW name (registered via ICE with QW display name).
  // Discord source: look up via knownPlayers[discordUserId] mapping.
  const isMumbleSource = session.source === 'mumble';
  const resolvedQwNames = new Set<string>();
  for (const track of session.tracks) {
    if (isMumbleSource && track.mumble_username) {
      resolvedQwNames.add(track.mumble_username.toLowerCase());
    } else if (track.discord_user_id) {
      const qwName = knownPlayers[track.discord_user_id];
      if (qwName) {
        resolvedQwNames.add(qwName.toLowerCase());
      }
    }
  }

  if (teamTag || resolvedQwNames.size > 0) {
    logger.info('Match filtering enabled', {
      teamTag: teamTag || '(none)',
      resolvedPlayers: [...resolvedQwNames],
    });
  } else {
    logger.warn('No team tag or player mapping — all hub matches will be paired (unfiltered)');
  }

  // Filter hub matches to only our team's matches
  const hasFilters = teamTag !== '' || resolvedQwNames.size > 0;
  const filtered = hasFilters ? filterOurMatches(hubMatches, teamTag, resolvedQwNames) : hubMatches;

  logger.info('Hub matches filtered', {
    total: hubMatches.length,
    kept: filtered.length,
    discarded: hubMatches.length - filtered.length,
  });

  const recordingStart = new Date(session.recording_start_time);
  const pairings: MatchPairing[] = [];

  for (const match of filtered) {
    const matchTsStr = match.timestamp;
    if (!matchTsStr) {
      logger.warn('Match has no timestamp, skipping', { matchId: match.id });
      continue;
    }

    const matchTs = new Date(matchTsStr);

    // Get ktxstats if available
    const demoSha = match.demo_sha256 ?? '';
    const ktxstats = statsMap.get(demoSha) ?? null;

    // Hub timestamp = demo start (= countdown start, derived from MVD filename).
    // ktxstats.date = match end time, ktxstats.duration = gameplay only (excl countdown).
    // Audio should span from demo start to match end (countdown + gameplay).
    const audioStart = (matchTs.getTime() - recordingStart.getTime()) / 1000;

    let audioEnd: number;
    let duration: number;
    const ktxDateStr = ktxstats?.date as string | undefined;
    if (ktxDateStr) {
      // Exact end time from ktxstats
      // Format: "2026-02-17 20:58:51 +0100" → "2026-02-17T20:58:51+01:00"
      const ktxEnd = new Date(
        ktxDateStr
          .replace(' ', 'T')                              // date-time separator
          .replace(/ ([+-])(\d{2})(\d{2})$/, '$1$2:$3'),  // " +0100" → "+01:00"
      );
      audioEnd = (ktxEnd.getTime() - recordingStart.getTime()) / 1000;
      duration = audioEnd - audioStart;

      // NaN guard — if ktxstats date didn't parse, fall back to default duration
      if (!Number.isFinite(audioEnd) || !Number.isFinite(duration) || duration <= 0) {
        logger.warn('Invalid ktxstats date, using default duration', {
          matchId: match.id,
          ktxDateStr,
          audioEnd,
          duration,
        });
        duration = defaultMatchLength;
        audioEnd = audioStart + duration;
      }
    } else {
      duration = defaultMatchLength;
      audioEnd = audioStart + duration;
    }

    // Score confidence
    const { score, reasons } = scoreConfidence(match, session, audioStart, ktxstats !== null, knownPlayers);

    pairings.push({
      matchId: match.id ?? 0,
      mapName: match.map ?? 'unknown',
      timestamp: matchTs,
      serverHostname: match.hostname ?? '',
      teams: match.teams ?? [],
      players: match.players ?? [],
      ktxstats,
      durationSeconds: duration,
      audioOffsetSeconds: audioStart,
      audioEndSeconds: audioEnd,
      confidence: score,
      confidenceReasons: reasons,
      demoSha256: demoSha,
    });
  }

  // Sort by audio offset
  pairings.sort((a, b) => a.audioOffsetSeconds - b.audioOffsetSeconds);

  // Validate no overlapping segments
  validateNoOverlap(pairings);

  for (const p of pairings) {
    logger.info('Paired match', {
      matchId: p.matchId,
      map: p.mapName,
      offsetStart: p.audioOffsetSeconds.toFixed(1),
      offsetEnd: p.audioEndSeconds.toFixed(1),
      confidence: p.confidence,
    });
  }

  return pairings;
}

/**
 * Filter hub matches to only those belonging to our team.
 *
 * A match passes if:
 * - Any team name matches the team tag (case-insensitive), OR
 * - At least MIN_PLAYER_OVERLAP of the resolved QW names appear in the match
 */
function filterOurMatches(
  hubMatches: HubMatch[],
  teamTag: string,
  resolvedQwNames: Set<string>,
): HubMatch[] {
  return hubMatches.filter((match) => {
    // Check team tag match
    if (teamTag) {
      const tagMatch = (match.teams ?? []).some(
        (t) => t.name?.toLowerCase() === teamTag,
      );
      if (tagMatch) return true;
    }

    // Check player name overlap (normalized — strips QW decorations + Discord punctuation)
    if (resolvedQwNames.size > 0) {
      const matchPlayerNorms = (match.players ?? [])
        .map((p) => p.name ? normalizeName(p.name) : '')
        .filter(Boolean);
      let overlap = 0;
      for (const qwName of resolvedQwNames) {
        const norm = normalizeName(qwName);
        if (norm.length < 2) continue;
        if (matchPlayerNorms.some((hubNorm) => hubNorm.includes(norm) || norm.includes(hubNorm))) overlap++;
      }
      if (overlap >= MIN_PLAYER_OVERLAP) return true;
    }

    return false;
  });
}

/**
 * Score confidence of a match pairing (0.0 - 1.0).
 *
 * Factors:
 *   - Offset is positive and reasonable (weight 0.3)
 *   - ktxstats available for exact duration (weight 0.2)
 *   - Player name overlap between recording tracks and match players (weight 0.3)
 *   - Offset within session window (weight 0.2)
 */
function scoreConfidence(
  match: HubMatch,
  session: SessionMetadata,
  audioOffset: number,
  hasKtxstats: boolean,
  knownPlayers: Record<string, string> = {},
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  // Factor 1: Offset is positive and reasonable (weight 0.3)
  if (audioOffset > 60) {
    score += 0.3;
    reasons.push('offset > 60s into recording');
  } else if (audioOffset > 0) {
    score += 0.15;
    reasons.push(`offset positive but small (${audioOffset.toFixed(1)}s)`);
  } else {
    reasons.push(`offset negative (${audioOffset.toFixed(1)}s) - match before recording`);
  }

  // Factor 2: ktxstats available (weight 0.2)
  if (hasKtxstats) {
    score += 0.2;
    reasons.push('ktxstats available (exact duration)');
  } else {
    reasons.push('no ktxstats (using default duration)');
  }

  // Factor 3: Player name overlap (weight 0.3)
  // Hub player names have QW decorations (e.g., "• razor", "tco.........axe")
  // Use substring matching: check if hub name contains any known name
  const sessionNames = new Set<string>();
  const isMumble = session.source === 'mumble';
  for (const track of session.tracks) {
    if (isMumble && track.mumble_username) {
      // Mumble: username IS the QW name
      sessionNames.add(normalizeName(track.mumble_username));
    } else {
      // Discord: resolved QW names from knownPlayers (most reliable — stable nicks)
      if (track.discord_user_id) {
        const qwName = knownPlayers[track.discord_user_id];
        if (qwName) sessionNames.add(normalizeName(qwName));
      }
      // Discord names as fallback
      if (track.discord_username) sessionNames.add(normalizeName(track.discord_username));
      if (track.discord_display_name) sessionNames.add(normalizeName(track.discord_display_name));
    }
  }

  const matchPlayerNorms = (match.players ?? [])
    .map((p) => p.name ? normalizeName(p.name) : '')
    .filter(Boolean);

  let overlapCount = 0;
  for (const name of sessionNames) {
    if (name.length < 3) continue; // Skip very short names to avoid false positives
    if (matchPlayerNorms.some((hubNorm) => hubNorm.includes(name) || name.includes(hubNorm))) overlapCount++;
  }

  if (overlapCount >= 3) {
    score += 0.3;
    reasons.push(`${overlapCount} player names match recording tracks`);
  } else if (overlapCount >= 1) {
    const frac = overlapCount / 3;
    score += 0.3 * frac;
    reasons.push(`${overlapCount} player name(s) match recording tracks`);
  } else {
    reasons.push('no player name overlap with recording tracks');
  }

  // Factor 4: Offset within recording duration (weight 0.2)
  const maxSession = MAX_SESSION_HOURS * 3600;
  if (audioOffset > 0 && audioOffset < maxSession) {
    score += 0.2;
    reasons.push('offset within reasonable session window');
  } else {
    reasons.push(`offset ${audioOffset.toFixed(1)}s outside expected range`);
  }

  return { score: Math.round(score * 100) / 100, reasons };
}

/**
 * Trim overlapping pairings at their midpoint (mutates in place).
 */
function validateNoOverlap(pairings: MatchPairing[]): void {
  for (let i = 1; i < pairings.length; i++) {
    const prev = pairings[i - 1];
    const curr = pairings[i];

    if (curr.audioOffsetSeconds < prev.audioEndSeconds) {
      const midpoint = (prev.audioEndSeconds + curr.audioOffsetSeconds) / 2;
      prev.audioEndSeconds = midpoint;
      curr.audioOffsetSeconds = midpoint;
      logger.warn('Trimmed overlap between matches', {
        matchA: prev.matchId,
        matchB: curr.matchId,
        midpoint: midpoint.toFixed(1),
      });
    }
  }
}

/**
 * Format a human-readable summary of match pairings.
 */
export function formatPairingSummary(pairings: MatchPairing[]): string {
  if (pairings.length === 0) {
    return 'No matches paired to this recording.';
  }

  const lines: string[] = [`Found ${pairings.length} match(es):\n`];

  for (let i = 0; i < pairings.length; i++) {
    const p = pairings[i];
    const teamStr = p.teams
      .map((t: HubTeam) => `${t.name ?? '?'} (${t.frags ?? '?'})`)
      .join(' vs ');

    lines.push(`  [${i + 1}] ${p.mapName} - ${teamStr}`);
    lines.push(`      Time: ${p.timestamp.toISOString().slice(11, 19)} UTC`);
    lines.push(`      Audio: ${p.audioOffsetSeconds.toFixed(1)}s -> ${p.audioEndSeconds.toFixed(1)}s`);
    lines.push(`      Duration: ${p.durationSeconds.toFixed(0)}s`);
    lines.push(`      Confidence: ${(p.confidence * 100).toFixed(0)}%`);
    for (const reason of p.confidenceReasons) {
      lines.push(`        - ${reason}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
