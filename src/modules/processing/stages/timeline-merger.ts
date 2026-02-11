/**
 * Merge per-player transcripts into a unified chronological timeline.
 *
 * The timeline is the central data format — all analysis reads from it.
 * Pure data transformations, no I/O.
 */

import type {
  TranscriptSegment,
  TimelineEntry,
  OverlapEvent,
  PlayerStats,
  CommunicationStats,
} from '../types.js';
import { logger } from '../../../core/logger.js';

/**
 * Merge per-player transcripts into a single chronological timeline.
 *
 * @param transcripts - Map of player name to their transcript segments
 * @returns Unified timeline sorted by start time, then speaker name for stable ordering
 */
export function mergeTranscripts(
  transcripts: Record<string, TranscriptSegment[]>,
): TimelineEntry[] {
  const timeline: TimelineEntry[] = [];

  for (const [playerName, segments] of Object.entries(transcripts)) {
    for (const seg of segments) {
      timeline.push({
        speaker: playerName,
        start: seg.start,
        end: seg.end,
        text: seg.text,
        confidence: seg.confidence ?? null,
      });
    }
  }

  timeline.sort((a, b) => a.start - b.start || a.speaker.localeCompare(b.speaker));

  logger.info('Merged transcripts into timeline', {
    players: Object.keys(transcripts).length,
    entries: timeline.length,
  });

  return timeline;
}

/**
 * Detect overlapping speech between different speakers.
 *
 * Uses the sorted order of the timeline to efficiently find overlaps:
 * for each entry, only check subsequent entries until their start >= current end.
 * Ignores same-speaker overlaps and tiny overlaps < 100ms.
 */
export function detectOverlaps(timeline: TimelineEntry[]): OverlapEvent[] {
  const overlaps: OverlapEvent[] = [];

  for (let i = 0; i < timeline.length; i++) {
    const entryA = timeline[i];

    for (let j = i + 1; j < timeline.length; j++) {
      const entryB = timeline[j];

      // Stop checking once we're past possible overlap
      if (entryB.start >= entryA.end) {
        break;
      }

      // Skip same-speaker overlaps
      if (entryA.speaker === entryB.speaker) {
        continue;
      }

      const overlapStart = Math.max(entryA.start, entryB.start);
      const overlapEnd = Math.min(entryA.end, entryB.end);
      const overlapDuration = overlapEnd - overlapStart;

      if (overlapDuration > 0.1) {
        const speakers = [entryA.speaker, entryB.speaker].sort() as [string, string];
        overlaps.push({
          speakers,
          start: Math.round(overlapStart * 1000) / 1000,
          end: Math.round(overlapEnd * 1000) / 1000,
          duration: Math.round(overlapDuration * 1000) / 1000,
          texts: {
            [entryA.speaker]: entryA.text,
            [entryB.speaker]: entryB.text,
          },
        });
      }
    }
  }

  logger.info('Detected speech overlaps', { count: overlaps.length });

  return overlaps;
}

/**
 * Compute per-player and team-wide communication statistics.
 *
 * @param timeline - Merged timeline entries
 * @param totalDuration - Optional total segment duration in seconds (for silence percentage)
 */
export function computeStats(
  timeline: TimelineEntry[],
  totalDuration?: number,
): CommunicationStats {
  const speakers: Record<string, { segments: number; totalSpeakingTime: number; totalWords: number }> = {};

  for (const entry of timeline) {
    const name = entry.speaker;
    if (!speakers[name]) {
      speakers[name] = { segments: 0, totalSpeakingTime: 0, totalWords: 0 };
    }
    const s = speakers[name];
    s.segments += 1;
    s.totalSpeakingTime += entry.end - entry.start;
    s.totalWords += entry.text.split(/\s+/).filter(w => w.length > 0).length;
  }

  const playerStats: Record<string, PlayerStats> = {};
  let totalSpeaking = 0;
  let totalSegments = 0;

  for (const [name, data] of Object.entries(speakers)) {
    const avgDuration = data.segments > 0
      ? Math.round((data.totalSpeakingTime / data.segments) * 100) / 100
      : 0;
    const wpm = data.totalSpeakingTime > 0
      ? Math.round((data.totalWords / (data.totalSpeakingTime / 60)) * 10) / 10
      : 0;

    playerStats[name] = {
      segments: data.segments,
      totalSpeakingTime: Math.round(data.totalSpeakingTime * 100) / 100,
      totalWords: data.totalWords,
      avgSegmentDuration: avgDuration,
      wordsPerMinute: wpm,
    };

    totalSpeaking += data.totalSpeakingTime;
    totalSegments += data.segments;
  }

  const playerCount = Object.keys(speakers).length;

  const stats: CommunicationStats = {
    playerStats,
    team: {
      totalSegments,
      totalSpeakingTime: Math.round(totalSpeaking * 100) / 100,
      playerCount,
    },
  };

  if (totalDuration !== undefined && totalDuration > 0) {
    stats.team.totalDuration = totalDuration;
    stats.team.silencePercentage = Math.round(
      (1 - totalSpeaking / (totalDuration * playerCount)) * 1000,
    ) / 10;
  }

  return stats;
}

/**
 * Format timeline entries as readable text for Claude analysis prompts.
 *
 * @param timeline - Merged timeline entries
 * @param maxEntries - Maximum number of entries to include (default 500)
 * @returns Formatted text like `[MM:SS.ss] Speaker: text`
 */
export function formatTimeline(timeline: TimelineEntry[], maxEntries = 500): string {
  const entries = timeline.slice(0, maxEntries);
  const lines: string[] = [];

  for (const entry of entries) {
    const totalSeconds = entry.start;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds - minutes * 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = seconds.toFixed(2).padStart(5, '0');
    lines.push(`[${mm}:${ss}] ${entry.speaker}: ${entry.text}`);
  }

  if (timeline.length > maxEntries) {
    lines.push(`\n... (${timeline.length - maxEntries} more entries truncated)`);
  }

  return lines.join('\n');
}
