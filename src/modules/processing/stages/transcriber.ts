/**
 * Transcriber stage — spawns the Python faster-whisper wrapper and
 * re-segments raw Whisper output into callout-sized chunks.
 */

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../../core/logger.js';
import { buildWhisperPrompt } from '../utils.js';
import type { ProcessingConfig } from '../../../core/config.js';
import type {
  TranscriptSegment,
  RawWhisperOutput,
  RawWhisperSegment,
  RawWhisperWord,
} from '../types.js';

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = join(__filename, '..', '..', '..', '..', '..');
const SCRIPT_PATH = join(PROJECT_ROOT, 'scripts', 'transcribe.py');

/** Two-hour timeout for long recording sessions. */
const TRANSCRIBE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

/** Default silence gap threshold for re-segmentation (ms). */
const DEFAULT_SILENCE_GAP_MS = 800;

// ------------------------------------------------------------------
// Public API
// ------------------------------------------------------------------

/**
 * Transcribe all audio files in a directory.
 *
 * Spawns the Python faster-whisper wrapper, collects its JSON output,
 * then re-segments each track by silence gaps between words.
 *
 * @returns Map of player name to re-segmented transcript segments.
 */
export async function transcribeDirectory(
  audioDir: string,
  config: ProcessingConfig,
  mapName?: string,
): Promise<Record<string, TranscriptSegment[]>> {
  const prompt = await buildWhisperPrompt(mapName ?? '');

  const args = [
    SCRIPT_PATH,
    audioDir,
    '--model', config.whisperModel,
    '--language', 'en',
  ];
  if (prompt) {
    args.push('--initial-prompt', prompt);
  }

  logger.info('Spawning transcriber', {
    audioDir,
    model: config.whisperModel,
    promptLength: prompt.length,
    mapName: mapName ?? '',
  });

  const rawJson = await spawnPython(args);

  let parsed: { tracks: Record<string, RawWhisperOutput> };
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Failed to parse transcriber JSON output: ${rawJson.slice(0, 200)}`);
  }

  const result: Record<string, TranscriptSegment[]> = {};

  for (const [playerName, trackOutput] of Object.entries(parsed.tracks)) {
    const segments = transcribeTrack(trackOutput.segments);
    result[playerName] = segments;

    const wordCount = segments.reduce((n, s) => n + s.text.split(/\s+/).length, 0);
    logger.info(`Transcribed ${playerName}`, {
      segments: segments.length,
      words: wordCount,
      duration: trackOutput.duration,
    });
  }

  return result;
}

// ------------------------------------------------------------------
// Re-segmentation (pure data transformation)
// ------------------------------------------------------------------

/**
 * Re-segment raw Whisper output by silence gaps between words.
 *
 * Whisper produces long sentence-like segments. This splits them into
 * shorter, callout-sized chunks wherever consecutive words are separated
 * by a gap >= silenceGapMs.
 */
export function transcribeTrack(
  rawSegments: RawWhisperSegment[],
  silenceGapMs: number = DEFAULT_SILENCE_GAP_MS,
): TranscriptSegment[] {
  const results: TranscriptSegment[] = [];

  for (const seg of rawSegments) {
    if (!seg.words || seg.words.length === 0) {
      // Fallback: no word timestamps — use segment as-is
      const text = seg.text.trim();
      if (text) {
        results.push({
          start: round3(seg.start),
          end: round3(seg.end),
          text,
          confidence: round4(seg.avg_logprob),
        });
      }
      continue;
    }

    // Walk words, flush when silence gap exceeds threshold
    let currentWords: RawWhisperWord[] = [];

    for (const word of seg.words) {
      if (currentWords.length > 0) {
        const gapMs = (word.start - currentWords[currentWords.length - 1].end) * 1000;
        if (gapMs >= silenceGapMs) {
          flushWordSegment(currentWords, seg.avg_logprob, results);
          currentWords = [];
        }
      }
      currentWords.push(word);
    }

    if (currentWords.length > 0) {
      flushWordSegment(currentWords, seg.avg_logprob, results);
    }
  }

  return results;
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function flushWordSegment(
  words: RawWhisperWord[],
  avgLogprob: number,
  results: TranscriptSegment[],
): void {
  const text = words.map((w) => w.word).join('').trim();
  if (!text) return;

  results.push({
    start: round3(words[0].start),
    end: round3(words[words.length - 1].end),
    text,
    confidence: round4(avgLogprob),
  });
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function spawnPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('python3', args, { timeout: TRANSCRIBE_TIMEOUT_MS, maxBuffer: 100 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (stderr) {
        // Python progress messages go to stderr — log them
        for (const line of stderr.split('\n')) {
          if (line.trim()) {
            logger.debug(`[transcribe.py] ${line}`);
          }
        }
      }
      if (error) {
        reject(new Error(`transcribe.py failed: ${error.message}\nstderr: ${stderr}`));
        return;
      }
      resolve(stdout);
    });
  });
}
