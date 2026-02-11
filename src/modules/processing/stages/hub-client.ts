/**
 * QW Hub API client — queries match history and ktxstats from the QW Hub Supabase API.
 *
 * Ported from voice-analysis/src/api/qwhub_client.py
 */

import { logger } from '../../../core/logger.js';
import type { HubMatch, KtxStats } from '../types.js';

const SUPABASE_URL = 'https://ncsphkjfominimxztjip.supabase.co/rest/v1/v1_games';
const SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5jc3Boa2pmb21pbmlteHp0amlwIiwicm9sZSI6ImFub24iLCJpYXQiOjE2OTY5Mzg1NjMsImV4cCI6MjAxMjUxNDU2M30.' +
  'NN6hjlEW-qB4Og9hWAVlgvUdwrbBO13s8OkAJuBGVbo';
const KTXSTATS_BASE_URL = 'https://d.quake.world';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SESSION_BUFFER_MINUTES = 15;

export interface HubClientConfig {
  supabaseUrl?: string;
  supabaseAnonKey?: string;
  ktxstatsBaseUrl?: string;
  timeoutMs?: number;
  sessionBufferMinutes?: number;
}

export class QWHubClient {
  private readonly url: string;
  private readonly anonKey: string;
  private readonly ktxstatsBase: string;
  private readonly timeoutMs: number;
  private readonly sessionBufferMinutes: number;
  private readonly abortController: AbortController;

  constructor(config?: HubClientConfig) {
    this.url = config?.supabaseUrl ?? SUPABASE_URL;
    this.anonKey = config?.supabaseAnonKey ?? SUPABASE_ANON_KEY;
    this.ktxstatsBase = config?.ktxstatsBaseUrl ?? KTXSTATS_BASE_URL;
    this.timeoutMs = config?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sessionBufferMinutes = config?.sessionBufferMinutes ?? DEFAULT_SESSION_BUFFER_MINUTES;
    this.abortController = new AbortController();
  }

  /**
   * Query QW Hub for matches in a time window.
   *
   * @param startTime ISO 8601 timestamp (inclusive)
   * @param endTime ISO 8601 timestamp (exclusive)
   * @param playerQuery Full-text search on players column
   * @param mode Game mode filter (default: 4on4)
   */
  async findMatches(
    startTime: string,
    endTime: string,
    playerQuery?: string,
    mode: string = '4on4',
  ): Promise<HubMatch[]> {
    const params = new URLSearchParams({
      mode: `eq.${mode}`,
      timestamp: `gte.${startTime}`,
      and: `(timestamp.lt.${endTime})`,
      order: 'timestamp.asc',
    });

    if (playerQuery) {
      params.set('players_fts', `fts.${playerQuery}`);
    }

    const url = `${this.url}?${params.toString()}`;
    logger.info('Querying QW Hub', { startTime, endTime, playerQuery: playerQuery ?? null });

    const response = await fetch(url, {
      headers: {
        apikey: this.anonKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.any([
        this.abortController.signal,
        AbortSignal.timeout(this.timeoutMs),
      ]),
    });

    if (!response.ok) {
      throw new Error(`QW Hub API error: ${response.status} ${response.statusText}`);
    }

    const matches = (await response.json()) as HubMatch[];
    logger.info('Found matches from QW Hub', { count: matches.length });
    return matches;
  }

  /**
   * Fetch ktxstats JSON for a demo by its SHA256 hash.
   *
   * @returns Parsed KtxStats or null if unavailable
   */
  async fetchKtxstats(demoSha256: string): Promise<KtxStats | null> {
    if (!demoSha256) return null;

    const prefix = demoSha256.slice(0, 3);
    const url = `${this.ktxstatsBase}/${prefix}/${demoSha256}.mvd.ktxstats.json`;
    logger.info('Fetching ktxstats', { url });

    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.any([
          this.abortController.signal,
          AbortSignal.timeout(this.timeoutMs),
        ]),
      });

      if (response.status === 404) {
        logger.warn('ktxstats not found', { demoSha256: demoSha256.slice(0, 16) });
        return null;
      }

      if (!response.ok) {
        throw new Error(`ktxstats fetch error: ${response.status} ${response.statusText}`);
      }

      return (await response.json()) as KtxStats;
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      logger.warn('ktxstats request failed', {
        demoSha256: demoSha256.slice(0, 16),
        error: String(error),
      });
      return null;
    }
  }

  /**
   * Find matches that fall within a recording session window.
   *
   * Adds a buffer before and after the recording window to account for
   * clock drift and matches that may have started before recording.
   *
   * @param recordingStart ISO 8601 start time of the recording
   * @param recordingDurationSeconds Total duration of the recording in seconds
   * @param playerQuery Full-text search on players column
   */
  async findMatchesForSession(
    recordingStart: string,
    recordingDurationSeconds: number,
    playerQuery?: string,
  ): Promise<HubMatch[]> {
    const startDt = new Date(recordingStart);
    const bufferMs = this.sessionBufferMinutes * 60 * 1000;

    const windowStart = new Date(startDt.getTime() - bufferMs);
    const windowEnd = new Date(startDt.getTime() + recordingDurationSeconds * 1000 + bufferMs);

    return this.findMatches(
      windowStart.toISOString(),
      windowEnd.toISOString(),
      playerQuery,
    );
  }

  /**
   * Cancel any in-flight requests and clean up.
   */
  close(): void {
    this.abortController.abort();
  }
}
