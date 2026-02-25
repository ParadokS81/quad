/**
 * Pipeline orchestrator — two-stage processing of recording sessions.
 *
 * Fast pipeline (auto, seconds):
 *   parse session_metadata.json → QW Hub API → pair matches → fetch ktxstats → split audio
 *
 * Slow pipeline (opt-in, hours on CPU):
 *   transcribe → merge timelines → Claude analysis
 *
 * Status tracked via pipeline_status.json in the processed/ directory.
 */

import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { logger } from '../../core/logger.js';
import type { ProcessingConfig } from '../../core/config.js';
import type {
  SessionMetadata,
  MatchPairing,
  SegmentMetadata,
  PipelineStatus,
  PipelineStage,
  KtxStats,
  TimelineEntry,
  OverlapEvent,
  CommunicationStats,
  TranscriptSegment,
} from './types.js';

import { QWHubClient } from './stages/hub-client.js';
import { pairMatches, formatPairingSummary } from './stages/match-pairer.js';
import { getRegistrationsForGuild, type BotRegistration } from '../registration/register.js';
import { splitByTimestamps, extractIntermissions } from './stages/audio-splitter.js';
import { transcribeDirectory } from './stages/transcriber.js';
import { mergeTranscripts, detectOverlaps, computeStats, formatTimeline } from './stages/timeline-merger.js';
import { analyzeMap, type AnalysisResult } from './stages/analyzer.js';

// ============================================================
// Status tracking
// ============================================================

function statusPath(processedDir: string): string {
  return join(processedDir, 'pipeline_status.json');
}

async function readStatus(processedDir: string): Promise<PipelineStatus | null> {
  try {
    const raw = await readFile(statusPath(processedDir), 'utf-8');
    return JSON.parse(raw) as PipelineStatus;
  } catch {
    return null;
  }
}

async function writeStatus(processedDir: string, status: PipelineStatus): Promise<void> {
  await writeFile(statusPath(processedDir), JSON.stringify(status, null, 2), 'utf-8');
}

function makeStatus(sessionId: string, stage: PipelineStage, currentStep: string, partial?: Partial<PipelineStatus>): PipelineStatus {
  return {
    sessionId,
    stage,
    currentStep,
    startedAt: partial?.startedAt ?? new Date().toISOString(),
    completedAt: partial?.completedAt,
    error: partial?.error,
    matchCount: partial?.matchCount ?? 0,
    segmentCount: partial?.segmentCount ?? 0,
  };
}

// ============================================================
// Session resolution
// ============================================================

/**
 * Find a session directory by ID, or return the most recent session.
 */
export async function resolveSessionDir(recordingDir: string, sessionId?: string | null): Promise<string | null> {
  if (sessionId) {
    const dir = join(recordingDir, sessionId);
    try {
      const s = await stat(dir);
      if (s.isDirectory()) return dir;
    } catch {
      return null;
    }
    return null;
  }

  // Find most recent session by directory mtime
  try {
    const entries = await readdir(recordingDir, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory());
    if (dirs.length === 0) return null;

    let newest: { name: string; mtime: number } | null = null;
    for (const d of dirs) {
      const fullPath = join(recordingDir, d.name);
      const s = await stat(fullPath);
      if (!newest || s.mtimeMs > newest.mtime) {
        newest = { name: d.name, mtime: s.mtimeMs };
      }
    }

    return newest ? join(recordingDir, newest.name) : null;
  } catch {
    return null;
  }
}

/**
 * Read and parse session_metadata.json from a session directory.
 */
export async function loadSessionMetadata(sessionDir: string): Promise<SessionMetadata> {
  const metaPath = join(sessionDir, 'session_metadata.json');
  const raw = await readFile(metaPath, 'utf-8');
  return JSON.parse(raw) as SessionMetadata;
}

/**
 * Get the processed/ subdirectory for a session, creating it if needed.
 */
async function ensureProcessedDir(sessionDir: string): Promise<string> {
  const dir = join(sessionDir, 'processed');
  await mkdir(dir, { recursive: true });
  return dir;
}

// ============================================================
// In-flight tracking (prevent concurrent runs on the same session)
// ============================================================

const runningPipelines = new Set<string>();

export function isRunning(sessionId: string): boolean {
  return runningPipelines.has(sessionId);
}

// ============================================================
// Fast pipeline
// ============================================================

export interface FastPipelineResult {
  pairings: MatchPairing[];
  segments: SegmentMetadata[];
  intermissions: SegmentMetadata[];
  summary: string;
}

/**
 * Run the fast pipeline: hub query → match pairing → audio splitting.
 * Takes seconds. Safe to run automatically after recording stops.
 */
export async function runFastPipeline(
  sessionDir: string,
  config: ProcessingConfig,
): Promise<FastPipelineResult> {
  const session = await loadSessionMetadata(sessionDir);
  const sessionId = session.recording_id;
  const processedDir = await ensureProcessedDir(sessionDir);

  if (runningPipelines.has(sessionId)) {
    throw new Error(`Pipeline already running for session ${sessionId}`);
  }
  runningPipelines.add(sessionId);

  const startedAt = new Date().toISOString();

  try {
    // Stage 1: Parse (already done above)
    await writeStatus(processedDir, makeStatus(sessionId, 'parsing', 'Reading session metadata', { startedAt }));
    logger.info('Fast pipeline started', { sessionId, sessionDir });

    // Look up bot registration for team tag + player mapping (before Hub query so we can build dynamic player filter)
    let teamTag = session.team?.tag ?? '';
    let knownPlayers: Record<string, string> = {};
    let registration: BotRegistration | null = null;
    try {
      const registrations = await getRegistrationsForGuild(session.guild.id);
      if (registrations.length === 1) {
        registration = registrations[0];
      } else if (registrations.length > 1) {
        const sourceChannel = session.source_text_channel_id;
        if (sourceChannel) {
          registration = registrations.find(r => r.registeredChannelId === sourceChannel) || null;
        }
      }
      if (registration) {
        teamTag = registration.teamTag || teamTag;
        knownPlayers = registration.knownPlayers || {};
        logger.info('Registration found for guild', {
          teamTag,
          knownPlayerCount: Object.keys(knownPlayers).length,
        });
      } else {
        logger.warn('No active registration for guild — match filtering will be limited', {
          guildId: session.guild.id,
        });
      }
    } catch (err) {
      logger.warn('Failed to look up registration — continuing with session metadata only', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Stage 2: Query QW Hub
    await writeStatus(processedDir, makeStatus(sessionId, 'querying', 'Querying QW Hub API', { startedAt }));

    const recordingStart = new Date(session.recording_start_time);
    const recordingEnd = new Date(session.recording_end_time);
    const durationSec = (recordingEnd.getTime() - recordingStart.getTime()) / 1000;

    // Build dynamic player query from registered players (replaces static PLAYER_QUERY env var)
    // Supabase FTS supports OR with pipe: "nasander|pkk|scenic"
    const registeredNames = Object.values(knownPlayers).filter(Boolean);
    const playerQuery = registeredNames.length > 0
      ? registeredNames.join('|')
      : config.playerQuery || undefined;

    if (playerQuery) {
      logger.info('Hub player query', { playerQuery, source: registeredNames.length > 0 ? 'registration' : 'env' });
    }

    const hub = new QWHubClient();
    let hubMatches: import('./types.js').HubMatch[];
    try {
      hubMatches = await hub.findMatchesForSession(
        session.recording_start_time,
        durationSec,
        playerQuery,
      );
    } catch (err) {
      logger.warn('Hub API query failed — continuing without match data', {
        error: err instanceof Error ? err.message : String(err),
      });
      hubMatches = [];
    } finally {
      hub.close();
    }

    // Stage 3: Pair matches + fetch ktxstats
    await writeStatus(processedDir, makeStatus(sessionId, 'pairing', 'Pairing matches + fetching ktxstats', { startedAt }));

    const ktxstatsMap = new Map<string, KtxStats>();
    if (hubMatches.length > 0) {
      const ktxHub = new QWHubClient();
      try {
        for (const match of hubMatches) {
          if (match.demo_sha256) {
            const stats = await ktxHub.fetchKtxstats(match.demo_sha256);
            if (stats) {
              ktxstatsMap.set(match.demo_sha256, stats);
            }
          }
        }
      } finally {
        ktxHub.close();
      }
    }

    const pairings = pairMatches(session, hubMatches, ktxstatsMap, { teamTag, knownPlayers });
    const summary = formatPairingSummary(pairings);
    logger.info('Match pairing complete', { matchCount: pairings.length });

    // Stage 4: Split audio
    let segments: SegmentMetadata[] = [];
    let intermissions: SegmentMetadata[] = [];

    if (pairings.length > 0) {
      await writeStatus(processedDir, makeStatus(sessionId, 'splitting', 'Splitting audio by match timestamps', {
        startedAt,
        matchCount: pairings.length,
      }));

      segments = await splitByTimestamps(session, pairings, processedDir, config.playerNameMap);

      if (config.processingIntermissions) {
        intermissions = await extractIntermissions(session, pairings, processedDir, config.playerNameMap);
      }
    } else {
      logger.info('No matches found — skipping audio split');
    }

    // Done
    const status = makeStatus(sessionId, 'complete', 'Fast pipeline complete', {
      startedAt,
      completedAt: new Date().toISOString(),
      matchCount: pairings.length,
      segmentCount: segments.length + intermissions.length,
    });
    await writeStatus(processedDir, status);

    // Upload voice recordings to Firebase Storage (best-effort, non-fatal)
    if (segments.length > 0) {
      try {
        const { uploadVoiceRecordings } = await import('./stages/voice-uploader.js');
        const guildId = session.guild.id;
        const uploadResult = await uploadVoiceRecordings(segments, teamTag, guildId, sessionId, registration);
        if (uploadResult.uploaded > 0) {
          logger.info('Voice recordings uploaded to Firebase', { ...uploadResult });

          // Keep source recordings for debugging — corrupt Opus packets
          // have been observed in some guilds (DAVE protocol issue).
          // TODO: Add retention policy (e.g. 7 days) once recording is stable.
          logger.info('Source recordings retained for debugging');
        }
      } catch (err) {
        logger.warn('Voice upload failed (non-fatal)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    logger.info('Fast pipeline complete', {
      sessionId,
      matches: pairings.length,
      segments: segments.length,
      intermissions: intermissions.length,
    });

    return { pairings, segments, intermissions, summary };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeStatus(processedDir, makeStatus(sessionId, 'error', errorMsg, {
      startedAt,
      error: errorMsg,
    })).catch(() => {});
    logger.error('Fast pipeline failed', { sessionId, error: errorMsg });
    throw err;
  } finally {
    runningPipelines.delete(sessionId);
  }
}

// ============================================================
// Slow pipeline: transcription + merge
// ============================================================

export interface TranscribeResult {
  segmentsProcessed: number;
  totalEntries: number;
}

/**
 * Run transcription on all segments of a session.
 * This is CPU-heavy (hours) and runs in the background.
 */
export async function runTranscribePipeline(
  sessionDir: string,
  config: ProcessingConfig,
): Promise<TranscribeResult> {
  const session = await loadSessionMetadata(sessionDir);
  const sessionId = session.recording_id;
  const processedDir = await ensureProcessedDir(sessionDir);

  if (runningPipelines.has(sessionId)) {
    throw new Error(`Pipeline already running for session ${sessionId}`);
  }
  runningPipelines.add(sessionId);

  const startedAt = new Date().toISOString();
  let segmentsProcessed = 0;
  let totalEntries = 0;

  try {
    // Discover segment directories
    const segmentDirs = await discoverSegmentDirs(processedDir);
    if (segmentDirs.length === 0) {
      throw new Error('No segments found. Run the fast pipeline first.');
    }

    await writeStatus(processedDir, makeStatus(sessionId, 'transcribing', `Transcribing 0/${segmentDirs.length} segments`, {
      startedAt,
      segmentCount: segmentDirs.length,
    }));

    for (const segDir of segmentDirs) {
      const metaPath = join(segDir, 'metadata.json');
      let segMeta: SegmentMetadata;
      try {
        segMeta = JSON.parse(await readFile(metaPath, 'utf-8')) as SegmentMetadata;
      } catch {
        logger.warn(`Skipping segment without metadata: ${segDir}`);
        continue;
      }

      const audioDir = join(segDir, 'audio');
      const transcriptsDir = join(segDir, 'transcripts');
      await mkdir(transcriptsDir, { recursive: true });

      // Transcribe
      const mapName = segMeta.isIntermission ? undefined : segMeta.map;
      const transcripts = await transcribeDirectory(audioDir, config, mapName);

      // Save per-player transcripts
      for (const [player, segments] of Object.entries(transcripts)) {
        const outPath = join(transcriptsDir, `${player}.json`);
        await writeFile(outPath, JSON.stringify(segments, null, 2), 'utf-8');
      }

      // Merge timeline
      const timeline = mergeTranscripts(transcripts);
      const overlaps = detectOverlaps(timeline);
      const segDuration = segMeta.endTime - segMeta.startTime;
      const stats = computeStats(timeline, segDuration);

      // Save merged outputs
      await writeFile(join(transcriptsDir, 'timeline.json'), JSON.stringify(timeline, null, 2), 'utf-8');
      await writeFile(join(transcriptsDir, 'timeline.txt'), formatTimeline(timeline), 'utf-8');
      await writeFile(join(transcriptsDir, 'overlaps.json'), JSON.stringify(overlaps, null, 2), 'utf-8');
      await writeFile(join(transcriptsDir, 'stats.json'), JSON.stringify(stats, null, 2), 'utf-8');

      segmentsProcessed++;
      totalEntries += timeline.length;

      await writeStatus(processedDir, makeStatus(sessionId, 'transcribing', `Transcribing ${segmentsProcessed}/${segmentDirs.length} segments`, {
        startedAt,
        segmentCount: segmentDirs.length,
      }));

      logger.info(`Transcribed segment: ${segMeta.dirName}`, {
        map: segMeta.map,
        entries: timeline.length,
        overlaps: overlaps.length,
      });
    }

    // Complete
    await writeStatus(processedDir, makeStatus(sessionId, 'complete', 'Transcription complete', {
      startedAt,
      completedAt: new Date().toISOString(),
      segmentCount: segmentDirs.length,
    }));

    logger.info('Transcription pipeline complete', { sessionId, segmentsProcessed, totalEntries });
    return { segmentsProcessed, totalEntries };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeStatus(processedDir, makeStatus(sessionId, 'error', errorMsg, {
      startedAt,
      error: errorMsg,
    })).catch(() => {});
    logger.error('Transcription pipeline failed', { sessionId, error: errorMsg });
    throw err;
  } finally {
    runningPipelines.delete(sessionId);
  }
}

// ============================================================
// Analysis pipeline
// ============================================================

export interface AnalyzePipelineResult {
  mapsAnalyzed: number;
  totalTokens: number;
}

/**
 * Run Claude analysis on all transcribed segments.
 * Requires transcripts to exist (run transcribe first).
 */
export async function runAnalyzePipeline(
  sessionDir: string,
  config: ProcessingConfig,
): Promise<AnalyzePipelineResult> {
  if (!config.anthropicApiKey) {
    throw new Error('ANTHROPIC_API_KEY is required for analysis');
  }

  const session = await loadSessionMetadata(sessionDir);
  const sessionId = session.recording_id;
  const processedDir = await ensureProcessedDir(sessionDir);

  if (runningPipelines.has(sessionId)) {
    throw new Error(`Pipeline already running for session ${sessionId}`);
  }
  runningPipelines.add(sessionId);

  const startedAt = new Date().toISOString();
  let mapsAnalyzed = 0;
  let totalTokens = 0;

  try {
    const segmentDirs = await discoverSegmentDirs(processedDir);
    if (segmentDirs.length === 0) {
      throw new Error('No segments found. Run the fast pipeline first.');
    }

    await writeStatus(processedDir, makeStatus(sessionId, 'analyzing', `Analyzing 0/${segmentDirs.length} segments`, {
      startedAt,
      segmentCount: segmentDirs.length,
    }));

    // Load intermission timelines for context (if any)
    const intermissionTimelines = await loadIntermissionTimelines(processedDir);

    for (const segDir of segmentDirs) {
      const metaPath = join(segDir, 'metadata.json');
      let segMeta: SegmentMetadata;
      try {
        segMeta = JSON.parse(await readFile(metaPath, 'utf-8')) as SegmentMetadata;
      } catch {
        continue;
      }

      // Skip intermissions for analysis
      if (segMeta.isIntermission) continue;

      const transcriptsDir = join(segDir, 'transcripts');

      // Load timeline
      let timeline: TimelineEntry[];
      try {
        timeline = JSON.parse(await readFile(join(transcriptsDir, 'timeline.json'), 'utf-8')) as TimelineEntry[];
      } catch {
        logger.warn(`No timeline for segment ${segMeta.dirName} — skipping analysis`);
        continue;
      }

      if (timeline.length === 0) {
        logger.info(`Empty timeline for ${segMeta.dirName} — skipping`);
        continue;
      }

      // Load stats and overlaps
      let stats: CommunicationStats;
      let overlaps: OverlapEvent[];
      try {
        stats = JSON.parse(await readFile(join(transcriptsDir, 'stats.json'), 'utf-8')) as CommunicationStats;
        overlaps = JSON.parse(await readFile(join(transcriptsDir, 'overlaps.json'), 'utf-8')) as OverlapEvent[];
      } catch {
        const segDuration = segMeta.endTime - segMeta.startTime;
        const transcripts: Record<string, TranscriptSegment[]> = {};
        for (const entry of timeline) {
          if (!transcripts[entry.speaker]) transcripts[entry.speaker] = [];
          transcripts[entry.speaker].push({ start: entry.start, end: entry.end, text: entry.text, confidence: entry.confidence ?? 0 });
        }
        stats = computeStats(timeline, segDuration);
        overlaps = detectOverlaps(timeline);
      }

      // Run analysis
      const analysisDir = join(segDir, 'analysis');
      await mkdir(analysisDir, { recursive: true });

      const result: AnalysisResult = await analyzeMap({
        timeline,
        stats,
        overlaps,
        mapName: segMeta.map,
        matchData: segMeta.matchData,
        ktxstats: segMeta.ktxstats ?? undefined,
        intermissionTimelines,
        apiKey: config.anthropicApiKey,
      });

      // Write results
      await writeFile(join(analysisDir, 'report.md'), result.report, 'utf-8');
      await writeFile(join(analysisDir, 'meta.json'), JSON.stringify(result.meta, null, 2), 'utf-8');

      mapsAnalyzed++;
      totalTokens += result.meta.inputTokens + result.meta.outputTokens;

      await writeStatus(processedDir, makeStatus(sessionId, 'analyzing', `Analyzed ${mapsAnalyzed}/${segmentDirs.length} segments`, {
        startedAt,
        segmentCount: segmentDirs.length,
      }));

      logger.info(`Analysis complete: ${segMeta.dirName}`, {
        map: segMeta.map,
        inputTokens: result.meta.inputTokens,
        outputTokens: result.meta.outputTokens,
      });
    }

    await writeStatus(processedDir, makeStatus(sessionId, 'complete', 'Analysis complete', {
      startedAt,
      completedAt: new Date().toISOString(),
      matchCount: mapsAnalyzed,
      segmentCount: segmentDirs.length,
    }));

    logger.info('Analysis pipeline complete', { sessionId, mapsAnalyzed, totalTokens });
    return { mapsAnalyzed, totalTokens };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    await writeStatus(processedDir, makeStatus(sessionId, 'error', errorMsg, {
      startedAt,
      error: errorMsg,
    })).catch(() => {});
    logger.error('Analysis pipeline failed', { sessionId, error: errorMsg });
    throw err;
  } finally {
    runningPipelines.delete(sessionId);
  }
}

// ============================================================
// Full rerun
// ============================================================

/**
 * Re-run the full pipeline from scratch on a session.
 * Runs fast pipeline, then optionally transcribe + analyze.
 */
export async function runFullPipeline(
  sessionDir: string,
  config: ProcessingConfig,
): Promise<void> {
  await runFastPipeline(sessionDir, config);

  if (config.processingTranscribe) {
    await runTranscribePipeline(sessionDir, config);

    if (config.anthropicApiKey) {
      await runAnalyzePipeline(sessionDir, config);
    }
  }
}

// ============================================================
// Status reading (for /process status command)
// ============================================================

/**
 * Get the current pipeline status for a session.
 */
export async function getPipelineStatus(sessionDir: string): Promise<PipelineStatus | null> {
  const processedDir = join(sessionDir, 'processed');
  return readStatus(processedDir);
}

/**
 * Format pipeline status for Discord display.
 */
export function formatStatus(status: PipelineStatus | null, sessionDir: string): string {
  if (!status) {
    const sessionId = sessionDir.split('/').pop() ?? sessionDir.split('\\').pop() ?? 'unknown';
    return `Session \`${sessionId.slice(0, 8)}\`: Not processed yet.`;
  }

  const shortId = status.sessionId.slice(0, 8);
  const stageEmoji: Record<string, string> = {
    idle: '\u23F8\uFE0F',
    parsing: '\u{1F4C4}',
    querying: '\u{1F50D}',
    pairing: '\u{1F517}',
    splitting: '\u2702\uFE0F',
    transcribing: '\u{1F3A4}',
    merging: '\u{1F500}',
    analyzing: '\u{1F9E0}',
    complete: '\u2705',
    error: '\u274C',
  };

  const emoji = stageEmoji[status.stage] ?? '\u2753';
  const lines = [
    `${emoji} **Session \`${shortId}\`** — ${status.stage}`,
    `Step: ${status.currentStep}`,
  ];

  if (status.matchCount > 0) {
    lines.push(`Matches: ${status.matchCount}`);
  }
  if (status.segmentCount > 0) {
    lines.push(`Segments: ${status.segmentCount}`);
  }
  if (status.startedAt) {
    lines.push(`Started: <t:${Math.floor(new Date(status.startedAt).getTime() / 1000)}:R>`);
  }
  if (status.completedAt) {
    lines.push(`Completed: <t:${Math.floor(new Date(status.completedAt).getTime() / 1000)}:R>`);
  }
  if (status.error) {
    lines.push(`Error: \`${status.error.slice(0, 200)}\``);
  }

  return lines.join('\n');
}

// ============================================================
// Helpers
// ============================================================

/**
 * Discover segment subdirectories in the processed/ folder.
 * Returns paths to directories that contain a metadata.json file.
 */
async function discoverSegmentDirs(processedDir: string): Promise<string[]> {
  try {
    const entries = await readdir(processedDir, { withFileTypes: true });
    const dirs: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(processedDir, entry.name);
      try {
        await stat(join(fullPath, 'metadata.json'));
        dirs.push(fullPath);
      } catch {
        // No metadata.json — skip
      }
    }

    // Sort by directory name (which includes date + index)
    dirs.sort();
    return dirs;
  } catch {
    return [];
  }
}

/**
 * Load intermission timelines for use as context during analysis.
 */
async function loadIntermissionTimelines(processedDir: string): Promise<Record<string, TimelineEntry[]>> {
  const result: Record<string, TimelineEntry[]> = {};

  try {
    const entries = await readdir(processedDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes('intermission')) continue;

      const timelinePath = join(processedDir, entry.name, 'transcripts', 'timeline.json');
      try {
        const raw = await readFile(timelinePath, 'utf-8');
        const timeline = JSON.parse(raw) as TimelineEntry[];
        if (timeline.length > 0) {
          result[entry.name] = timeline;
        }
      } catch {
        // No timeline for this intermission — skip
      }
    }
  } catch {
    // No processed dir or can't read — return empty
  }

  return result;
}
