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

export interface PairMatchesOptions {
  defaultDuration?: number;
}

/**
 * Pair QW Hub matches to positions in the recording.
 *
 * @param session Recording session metadata
 * @param hubMatches Matches from QW Hub API
 * @param ktxstatsMap Map of demo_sha256 -> KtxStats
 * @param options Pairing options (default duration)
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

  const recordingStart = new Date(session.recording_start_time);
  const pairings: MatchPairing[] = [];

  for (const match of hubMatches) {
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
      const ktxEnd = new Date(ktxDateStr.replace(' +0000', 'Z').replace(' ', 'T'));
      audioEnd = (ktxEnd.getTime() - recordingStart.getTime()) / 1000;
      duration = audioEnd - audioStart;
    } else {
      duration = defaultMatchLength;
      audioEnd = audioStart + duration;
    }

    // Score confidence
    const { score, reasons } = scoreConfidence(match, session, audioStart, ktxstats !== null);

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
  const sessionNames = new Set<string>();
  for (const track of session.tracks) {
    sessionNames.add(track.discord_username.toLowerCase());
    sessionNames.add(track.discord_display_name.toLowerCase());
  }

  const matchNames = new Set<string>();
  for (const player of match.players ?? []) {
    if (player.name) matchNames.add(player.name.toLowerCase());
  }

  let overlapCount = 0;
  for (const name of sessionNames) {
    if (matchNames.has(name)) overlapCount++;
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
