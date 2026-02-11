/**
 * Audio Splitter — splits per-speaker recordings into per-match segments using ffmpeg.
 *
 * Ported from voice-analysis/src/processing/timestamp_splitter.py
 */

import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { promisify } from 'node:util';

import { logger } from '../../../core/logger.js';
import type {
  MatchPairing,
  SegmentMetadata,
  SegmentPlayer,
  SessionMetadata,
  SessionTrack,
} from '../types.js';
import { resolvePlayerName } from '../utils.js';

const execFileAsync = promisify(execFile);

// ============================================================
// ffprobe / ffmpeg wrappers
// ============================================================

/**
 * Get audio duration in seconds using ffprobe (no decoding).
 */
export async function ffprobeDuration(audioPath: string): Promise<number> {
  const { stdout, stderr } = await execFileAsync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    audioPath,
  ]);

  const trimmed = stdout.trim();
  const duration = parseFloat(trimmed);
  if (isNaN(duration)) {
    throw new Error(`ffprobe returned invalid duration for ${audioPath}: ${stderr}`);
  }
  return duration;
}

/**
 * Slice audio using ffmpeg with stream copy (no re-encoding).
 * Returns the actual duration of the output file.
 */
export async function ffmpegSlice(
  inputPath: string,
  outputPath: string,
  startSec: number,
  endSec: number,
): Promise<number> {
  const { stderr } = await execFileAsync('ffmpeg', [
    '-y',
    '-ss', startSec.toFixed(3),
    '-to', endSec.toFixed(3),
    '-i', inputPath,
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    outputPath,
  ]);

  // Log ffmpeg warnings at debug level
  if (stderr) {
    logger.debug('ffmpeg output', { stderr: stderr.slice(-300) });
  }

  return ffprobeDuration(outputPath);
}

// ============================================================
// Utility functions
// ============================================================

/**
 * Clamp audio offsets to valid range within the track.
 * Returns null if the segment falls entirely outside the track.
 */
function clampOffsets(
  start: number,
  end: number,
  trackDuration: number,
): [number, number] | null {
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(trackDuration, end);

  if (clampedStart >= clampedEnd) {
    logger.warn(
      `Segment ${start.toFixed(1)}-${end.toFixed(1)} is outside track (${trackDuration.toFixed(1)}s), skipping player`,
    );
    return null;
  }

  return [clampedStart, clampedEnd];
}

/**
 * Build output directory name matching QW demo naming convention.
 * Format: 2026-02-01_]sr[_vs_red_dm4_01
 * Fallback: 2026-02-01_dm4_01
 */
function buildDirName(pairing: MatchPairing, index: number): string {
  const dateStr = pairing.timestamp.toISOString().slice(0, 10);
  const mapName = pairing.mapName;
  const idx = String(index + 1).padStart(2, '0');

  const teams = pairing.teams;
  if (teams.length >= 2) {
    const team1 = teams[0].name;
    const team2 = teams[1].name;
    if (team1 && team2) {
      return `${dateStr}_${team1}_vs_${team2}_${mapName}_${idx}`;
    }
  }

  return `${dateStr}_${mapName}_${idx}`;
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
async function ensureDir(dirPath: string): Promise<string> {
  await mkdir(dirPath, { recursive: true });
  return dirPath;
}

// ============================================================
// Main splitting functions
// ============================================================

/**
 * Split audio tracks into per-match segments using match timestamp offsets.
 */
export async function splitByTimestamps(
  session: SessionMetadata,
  pairings: MatchPairing[],
  outputDir: string,
  playerNameMap: Record<string, string> = {},
): Promise<SegmentMetadata[]> {
  const segments: SegmentMetadata[] = [];

  // Resolve audio file paths from session recording directory
  const recordingDir = join(outputDir, '..', session.recording_id);

  // Pre-fetch all track durations via ffprobe
  const trackDurations = new Map<number, number>();
  for (const track of session.tracks) {
    const audioPath = join(recordingDir, track.audio_file);
    try {
      trackDurations.set(track.track_number, await ffprobeDuration(audioPath));
    } catch (err) {
      logger.warn(`Cannot probe track ${track.track_number} (${track.discord_username}): ${err}`);
    }
  }

  for (let idx = 0; idx < pairings.length; idx++) {
    const pairing = pairings[idx];
    const dirName = buildDirName(pairing, idx);

    const audioDir = await ensureDir(join(outputDir, dirName, 'audio'));
    await ensureDir(join(outputDir, dirName, 'transcripts'));
    await ensureDir(join(outputDir, dirName, 'analysis'));

    const players: SegmentPlayer[] = [];

    for (const track of session.tracks) {
      const audioPath = join(recordingDir, track.audio_file);
      const trackDuration = trackDurations.get(track.track_number);

      if (trackDuration === undefined) {
        logger.warn(
          `Skipping track ${track.track_number} (${track.discord_username}): no audio file`,
        );
        continue;
      }

      const playerName = resolvePlayerName(
        track.discord_username,
        track.discord_display_name,
        playerNameMap,
      );

      const offsets = clampOffsets(
        pairing.audioOffsetSeconds,
        pairing.audioEndSeconds,
        trackDuration,
      );

      if (offsets === null) {
        continue;
      }

      const [startSec, endSec] = offsets;
      const audioExt = extname(track.audio_file).replace('.', '');
      const outPath = join(audioDir, `${playerName}.${audioExt}`);

      const actualDuration = await ffmpegSlice(audioPath, outPath, startSec, endSec);

      logger.info(
        `Split ${track.discord_username}: ${startSec.toFixed(1)}s-${endSec.toFixed(1)}s (${actualDuration.toFixed(1)}s) -> ${playerName}.${audioExt}`,
      );

      players.push({
        name: playerName,
        discordUsername: track.discord_username,
        audioFile: outPath,
        duration: actualDuration,
      });
    }

    const segment: SegmentMetadata = {
      index: idx,
      dirName,
      map: pairing.mapName,
      startTime: pairing.audioOffsetSeconds,
      endTime: pairing.audioEndSeconds,
      players,
      audioDir,
      matchId: pairing.matchId,
      gameId: pairing.matchId,
      demoSha256: pairing.demoSha256,
      matchData: {
        gameId: pairing.matchId,
        timestamp: pairing.timestamp.toISOString(),
        teams: pairing.teams,
        players: pairing.players,
        server: pairing.serverHostname,
        confidence: pairing.confidence,
        confidenceReasons: pairing.confidenceReasons,
      },
      ktxstats: pairing.ktxstats,
    };
    segments.push(segment);

    // Write metadata.json per segment
    const metadataPath = join(outputDir, dirName, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(segment, null, 2), 'utf-8');
    logger.info(`Wrote metadata: ${metadataPath}`);
  }

  // Write session-level metadata
  const sessionMeta = {
    recording_start_time: session.recording_start_time,
    recording_id: session.recording_id,
    guild_name: session.guild.name,
    channel_name: session.channel.name,
    tracks: session.tracks.map((t) => ({
      track_number: t.track_number,
      discord_username: t.discord_username,
      discord_display_name: t.discord_display_name,
    })),
    segments: segments.length,
    maps: segments.map((s) => s.map),
  };
  const sessionMetaPath = join(outputDir, 'session_metadata.json');
  await writeFile(sessionMetaPath, JSON.stringify(sessionMeta, null, 2), 'utf-8');

  logger.info(`Split ${segments.length} segments to ${outputDir}`);
  return segments;
}

/**
 * Extract audio from gaps between matches (pre-game, intermissions, post-game).
 *
 * These contain tactics discussion, debriefs, complaints, praise — valuable
 * context for understanding team dynamics beyond in-game callouts.
 */
export async function extractIntermissions(
  session: SessionMetadata,
  pairings: MatchPairing[],
  outputDir: string,
  playerNameMap: Record<string, string> = {},
  minGapSeconds: number = 30,
): Promise<SegmentMetadata[]> {
  const recordingDir = join(outputDir, '..', session.recording_id);

  // Get total recording duration from longest track
  let recordingDuration = 0;
  const trackDurations = new Map<number, number>();
  for (const track of session.tracks) {
    const audioPath = join(recordingDir, track.audio_file);
    try {
      const dur = await ffprobeDuration(audioPath);
      trackDurations.set(track.track_number, dur);
      recordingDuration = Math.max(recordingDuration, dur);
    } catch {
      // Track without audio file — skip
    }
  }

  if (recordingDuration === 0) {
    return [];
  }

  // Sort pairings by audio offset
  const sortedPairings = [...pairings].sort((a, b) => a.audioOffsetSeconds - b.audioOffsetSeconds);

  // Identify gaps
  const gaps: Array<{ label: string; start: number; end: number }> = [];

  // Gap before first match
  const firstStart = sortedPairings.length > 0
    ? sortedPairings[0].audioOffsetSeconds
    : recordingDuration;
  if (firstStart > minGapSeconds) {
    gaps.push({ label: 'pre-game', start: 0, end: firstStart });
  }

  // Gaps between matches
  for (let i = 0; i < sortedPairings.length - 1; i++) {
    const currentEnd = sortedPairings[i].audioEndSeconds;
    const nextStart = sortedPairings[i + 1].audioOffsetSeconds;
    const gapDuration = nextStart - currentEnd;
    if (gapDuration > minGapSeconds) {
      const prevMap = sortedPairings[i].mapName;
      const nextMap = sortedPairings[i + 1].mapName;
      gaps.push({ label: `between_${prevMap}_and_${nextMap}`, start: currentEnd, end: nextStart });
    }
  }

  // Gap after last match
  if (sortedPairings.length > 0) {
    const lastEnd = sortedPairings[sortedPairings.length - 1].audioEndSeconds;
    const remaining = recordingDuration - lastEnd;
    if (remaining > minGapSeconds) {
      gaps.push({ label: 'post-game', start: lastEnd, end: recordingDuration });
    }
  }

  if (gaps.length === 0) {
    logger.info('No significant gaps found between matches');
    return [];
  }

  logger.info(`Found ${gaps.length} intermission gap(s)`);

  const dateStr = new Date(session.recording_start_time).toISOString().slice(0, 10);
  const intermissions: SegmentMetadata[] = [];

  for (let gapIdx = 0; gapIdx < gaps.length; gapIdx++) {
    const { label, start: gapStart, end: gapEnd } = gaps[gapIdx];
    const dirName = `${dateStr}_intermission_${String(gapIdx + 1).padStart(2, '0')}_${label}`;

    const audioDir = await ensureDir(join(outputDir, dirName, 'audio'));
    await ensureDir(join(outputDir, dirName, 'transcripts'));

    const players: SegmentPlayer[] = [];

    for (const track of session.tracks) {
      const audioPath = join(recordingDir, track.audio_file);
      const trackDuration = trackDurations.get(track.track_number);

      if (trackDuration === undefined) {
        continue;
      }

      const playerName = resolvePlayerName(
        track.discord_username,
        track.discord_display_name,
        playerNameMap,
      );

      const offsets = clampOffsets(gapStart, gapEnd, trackDuration);
      if (offsets === null) {
        continue;
      }

      const [startSec, endSec] = offsets;
      const audioExt = extname(track.audio_file).replace('.', '');
      const outPath = join(audioDir, `${playerName}.${audioExt}`);

      const actualDuration = await ffmpegSlice(audioPath, outPath, startSec, endSec);

      logger.info(
        `Intermission ${label}: ${playerName} ${startSec.toFixed(1)}s-${endSec.toFixed(1)}s (${actualDuration.toFixed(1)}s)`,
      );

      players.push({
        name: playerName,
        discordUsername: track.discord_username,
        audioFile: outPath,
        duration: actualDuration,
      });
    }

    const segment: SegmentMetadata = {
      index: gapIdx,
      dirName,
      map: 'intermission',
      startTime: gapStart,
      endTime: gapEnd,
      duration: gapEnd - gapStart,
      players,
      audioDir,
      matchId: 0,
      gameId: 0,
      demoSha256: '',
      matchData: {
        gameId: 0,
        timestamp: '',
        teams: [],
        players: [],
        server: '',
        confidence: 0,
        confidenceReasons: [],
      },
      ktxstats: null,
      isIntermission: true,
      label,
    };
    intermissions.push(segment);

    // Write metadata per intermission
    const metadataPath = join(outputDir, dirName, 'metadata.json');
    await writeFile(metadataPath, JSON.stringify(segment, null, 2), 'utf-8');
  }

  logger.info(`Extracted ${intermissions.length} intermission segment(s)`);
  return intermissions;
}
