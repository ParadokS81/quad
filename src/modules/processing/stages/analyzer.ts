/**
 * Claude-powered analysis of voice communication timeline.
 *
 * Reads the merged timeline, stats, overlaps, and match data (ktxstats)
 * to generate actionable insights about team communication patterns.
 *
 * Ported from voice-analysis/src/analysis/analyzer.py
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../../core/logger.js';
import { loadKnowledge, formatWhisperCorrections } from '../utils.js';
import { formatTimeline } from './timeline-merger.js';
import type {
  TimelineEntry,
  OverlapEvent,
  CommunicationStats,
  KtxStats,
  KtxStatsPlayer,
  HubTeam,
  HubPlayer,
  SegmentMetadata,
} from '../types.js';

// ============================================================
// Types
// ============================================================

export interface AnalyzeMapOptions {
  timeline: TimelineEntry[];
  stats: CommunicationStats;
  overlaps: OverlapEvent[];
  mapName: string;
  matchData?: SegmentMetadata['matchData'];
  ktxstats?: KtxStats;
  intermissionTimelines?: Record<string, TimelineEntry[]>;
  apiKey: string;
  model?: string;
  maxTokens?: number;
}

export interface AnalysisResult {
  report: string;
  meta: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    timelineEntries: number;
    overlapEvents: number;
    hasMatchData: boolean;
    hasKtxstats: boolean;
  };
}

// ============================================================
// Knowledge YAML types
// ============================================================

interface MapStrategyInfo {
  name?: string;
  items?: Record<string, number>;
  key_strategies?: string[];
}

interface ReportSection {
  id: string;
  title: string;
  instruction?: string;
  optional?: boolean;
}

interface ReportTemplate {
  sections?: ReportSection[];
}

// ============================================================
// System prompt
// ============================================================

const SYSTEM_PROMPT = `You are an expert esports communication analyst specializing in team FPS games.
You are analyzing voice communications from a QuakeWorld 4on4 team deathmatch.

QuakeWorld context:
- 4v4 team deathmatch, 20 minute maps
- Key maps: dm3, dm2, e1m2, schloss, phantombase
- Critical items: Quad Damage (every 60s), Pent (every 5 min), Rocket Launcher, Lightning Gun
- Communication is essential for item timing, enemy positions, and team coordination
- Good comms: short, clear callouts with location and intent
- Bad comms: talking over each other, silence during fights, late callouts, inconsistent terminology

Voice callout conventions:
- Armor is always called by color: "red", "yellow", "green" (never "RA", "YA", "GA")
- Weapons: "rocket", "shaft" (lightning gun), "grenade", "sng", "buckshot" (SSG), "boomstick" (SG)
- Health status: "weak", "almost dead", "so dead" (NOT "low" which refers to a map location)
- "stacked"/"fat"/"strong" = well-equipped player
- Item timing: "[item] on [time]" = spawns at that second mark, "[item] in [x]" = spawns in x seconds
- "low" in callouts almost always refers to a map location, not health
- "bore pack" / "bore packs" = self-rocket to drop a backpack containing RL for a teammate
- "lost" = died (often accompanied by mm2 text bind showing death location)
- "map lock" = team has full map control, enemy can't get weapons
- "zone" = holding/controlling an area (e.g. "red zone")
- "build" = gather weapons/armor before a push (e.g. "build for penta")
- "team quad" / "team pent" = calling team to group for powerup pickup

Weapon tracking patterns:
- When an enemy holds a key weapon (RL/LG), the team tracks them in real-time
- Sequential calls like "rocket red" -> "rocket tunnel" -> "rocket bridge" mean ONE enemy
  with RL is moving through those locations. The weapon name IS the enemy identifier.
- Specific enemy names are called when tracking: "Milton has rocket", "Milton rocket"
- One stacked enemy with RL is a bigger threat than 3 weak enemies without weapons

Communication meta-patterns:
- Voice (mm3) and text binds (mm2) complement each other. Text binds show item timings,
  death locations, and status. Voice is for callouts, coordination, and reactions.
  The voice transcript alone is incomplete - players also communicate via text binds.
- Call urgency = volume + repetition. "take the rocket, take the rocket" is urgent.
  Calm calls like "yellow safe" are routine status reports.
- Unfinished sentences are normal. Players cut off when the situation changed, someone
  said something more important, or the info became irrelevant. Fragments are not errors.
- Quad timing is often approximate ("quad soon" = within ~10s) because the respawn
  cycle drifts by a few seconds each minute. Precise timing used when pickup was observed.
- Dying to enemy weapons is always reported (shows where enemy RL/LG is).
  Random deaths (bad spawns, suicides) may not be called on voice.

{commsContext}

Analyze the voice communication data and provide actionable feedback.
Be specific - reference exact timestamps, player names, and quotes.
Be constructive but honest. The team wants to improve.`;

const ANALYSIS_PROMPT_BASE = `Analyze this QuakeWorld 4on4 voice communication data.

## Map: {mapName}

{mapContextSection}

{matchResultSection}

{playerPerformanceSection}

{itemControlSection}

## Communication Statistics
{stats}

## Speech Overlaps (players talking over each other)
{overlaps}

## Full Timeline (chronological)
{timeline}

{intermissionSection}

---

Please provide analysis covering each of the following sections.
Format as a clean markdown report with each section as a heading.

{analysisSections}`;

// ============================================================
// Helper functions
// ============================================================

/**
 * Build analysis instruction sections from the report template YAML.
 */
async function buildAnalysisSections(hasIntermission: boolean): Promise<string> {
  const template = await loadKnowledge<ReportTemplate>('templates/map-report.yaml');
  if (!template?.sections) {
    return (
      '1. **Communication Balance** - Who talks most/least?\n' +
      '2. **Callout Quality** - Are callouts clear and consistent?\n' +
      '3. **Player Recommendations** - Concrete actions to improve\n'
    );
  }

  const lines: string[] = [];
  let num = 1;
  for (const section of template.sections) {
    if (section.optional && !hasIntermission) continue;

    const instruction = (section.instruction ?? '').trim();
    lines.push(`${num}. **${section.title}**\n${instruction}`);
    num++;
  }

  return lines.join('\n\n');
}

/**
 * Format map-specific strategy context for the analysis prompt.
 */
async function formatMapContext(mapName: string): Promise<string> {
  const strategies = await loadKnowledge<Record<string, MapStrategyInfo>>('maps/map-strategies.yaml');
  if (!strategies || !(mapName in strategies)) {
    return '## Map Context\nNo map-specific strategy data available.';
  }

  const info = strategies[mapName];
  const lines = [`## Map Context: ${info.name ?? mapName}`];

  if (info.items) {
    const itemStrs: string[] = [];
    for (const [item, count] of Object.entries(info.items)) {
      if (count) {
        itemStrs.push(`${item.replace(/_/g, ' ')}: ${count}`);
      }
    }
    lines.push(`Items: ${itemStrs.join(', ')}`);
  }

  if (info.key_strategies?.length) {
    lines.push('\nKey strategic context:');
    for (const s of info.key_strategies) {
      lines.push(`- ${s}`);
    }
  }

  return lines.join('\n');
}

/**
 * Format match result section for the analysis prompt.
 */
function formatMatchResult(matchData?: SegmentMetadata['matchData']): string {
  if (!matchData) {
    return '## Match Result\nNo match data available.';
  }

  const lines = ['## Match Result'];

  if (matchData.teams?.length) {
    const teamStrs = matchData.teams.map(
      (t) => `**${t.name ?? '?'}** (${t.frags ?? '?'} frags)`,
    );
    lines.push(teamStrs.join(' vs '));
  }

  if (matchData.server) {
    lines.push(`Server: ${matchData.server}`);
  }

  if (matchData.timestamp) {
    lines.push(`Time: ${matchData.timestamp}`);
  }

  if (matchData.confidence) {
    lines.push(`Match-recording confidence: ${(matchData.confidence * 100).toFixed(0)}%`);
  }

  return lines.join('\n');
}

/**
 * Format player performance section from ktxstats.
 */
function formatPlayerPerformance(ktxstats?: KtxStats, teamName?: string): string {
  if (!ktxstats) {
    return '## Player Performance\nNo ktxstats data available.';
  }

  if (!ktxstats.players?.length) {
    return '## Player Performance\nNo player data in ktxstats.';
  }

  const lines = ['## Player Performance'];
  const teamPlayers: KtxStatsPlayer[] = [];
  const enemyPlayers: KtxStatsPlayer[] = [];

  for (const p of ktxstats.players) {
    if (teamName && p.team === teamName) {
      teamPlayers.push(p);
    } else if (teamName) {
      enemyPlayers.push(p);
    } else {
      teamPlayers.push(p);
    }
  }

  if (teamPlayers.length) {
    lines.push(`\n### Team (${teamName || 'all'})`);
    const sorted = [...teamPlayers].sort((a, b) => (b.stats.frags ?? 0) - (a.stats.frags ?? 0));
    for (const p of sorted) {
      const { frags, deaths, damage_given, damage_taken } = p.stats;
      lines.push(`- **${p.name}**: ${frags}F/${deaths}D, dmg ${damage_given}/${damage_taken}`);

      // Weapon accuracy
      for (const [wepName, wepData] of Object.entries(p.weapons)) {
        if (typeof wepData === 'object' && wepData !== null) {
          const wd = wepData as Record<string, unknown>;
          const acc = wd.acc;
          if (typeof acc === 'object' && acc !== null) {
            const accObj = acc as Record<string, unknown>;
            if (typeof accObj.virtual === 'number') {
              lines.push(`  - ${wepName}: ${(accObj.virtual * 100).toFixed(0)}% acc`);
            }
          }
        }
      }
    }
  }

  if (enemyPlayers.length) {
    lines.push('\n### Opponents');
    const sorted = [...enemyPlayers].sort((a, b) => (b.stats.frags ?? 0) - (a.stats.frags ?? 0));
    for (const p of sorted) {
      lines.push(`- **${p.name}**: ${p.stats.frags}F/${p.stats.deaths}D`);
    }
  }

  return lines.join('\n');
}

/**
 * Format item control section from ktxstats.
 */
function formatItemControl(ktxstats?: KtxStats, teamName?: string): string {
  if (!ktxstats) {
    return '## Item Control\nNo ktxstats data available.';
  }

  if (!ktxstats.players?.length) {
    return '## Item Control\nNo player data in ktxstats.';
  }

  const lines = ['## Item Control'];
  const teamItems: Record<string, number> = {};
  const enemyItems: Record<string, number> = {};

  for (const p of ktxstats.players) {
    const isTeam = teamName ? p.team === teamName : true;
    const target = isTeam ? teamItems : enemyItems;

    for (const [itemName, itemData] of Object.entries(p.items)) {
      let count = 0;
      if (typeof itemData === 'object' && itemData !== null) {
        const id = itemData as Record<string, unknown>;
        count = (typeof id.count === 'number' ? id.count : 0) ||
                (typeof id.took === 'number' ? id.took : 0);
      } else if (typeof itemData === 'number') {
        count = itemData;
      }
      if (count) {
        target[itemName] = (target[itemName] ?? 0) + count;
      }
    }
  }

  if (Object.keys(teamItems).length) {
    lines.push(`\n### Team (${teamName || 'all'})`);
    const sorted = Object.entries(teamItems).sort(([, a], [, b]) => b - a);
    for (const [item, count] of sorted) {
      lines.push(`- ${item}: ${count}`);
    }
  }

  if (Object.keys(enemyItems).length) {
    lines.push('\n### Opponents');
    const sorted = Object.entries(enemyItems).sort(([, a], [, b]) => b - a);
    for (const [item, count] of sorted) {
      lines.push(`- ${item}: ${count}`);
    }
  }

  return lines.join('\n');
}

/**
 * Detect which in-game team is ours by matching speakers to ktxstats players.
 *
 * In pickup games the team name (e.g., 'mix') won't match the clan tag,
 * so we find the team with the most player name overlaps with our speakers.
 */
function detectOurTeam(ktxstats: KtxStats | undefined, stats: CommunicationStats): string {
  if (!ktxstats?.players?.length) return '';

  const speakers = new Set(
    Object.keys(stats.playerStats).map((n) => n.toLowerCase()),
  );
  if (!speakers.size) return '';

  const teamScores: Record<string, number> = {};
  for (const player of ktxstats.players) {
    const team = player.team ?? '';
    // Strip QW color codes (leading bullet character) and whitespace
    const name = player.name.replace(/^[\x1c\u2022]+/, '').trim().toLowerCase();
    if (speakers.has(name)) {
      teamScores[team] = (teamScores[team] ?? 0) + 1;
    }
  }

  if (!Object.keys(teamScores).length) return '';

  let bestTeam = '';
  let bestScore = 0;
  for (const [team, score] of Object.entries(teamScores)) {
    if (score > bestScore) {
      bestScore = score;
      bestTeam = team;
    }
  }
  return bestTeam;
}

// ============================================================
// Main analysis function
// ============================================================

/**
 * Run Claude analysis on voice communication data for a single map.
 */
export async function analyzeMap(options: AnalyzeMapOptions): Promise<AnalysisResult> {
  const {
    timeline,
    stats,
    overlaps,
    mapName,
    matchData,
    ktxstats,
    intermissionTimelines,
    apiKey,
    model = 'claude-sonnet-4-5-20250929',
    maxTokens = 8192,
  } = options;

  logger.info('Starting Claude analysis', { mapName, timelineEntries: timeline.length });

  // Detect our team
  const teamName = detectOurTeam(ktxstats, stats);

  // Format all sections
  const timelineText = formatTimeline(timeline);
  const statsText = JSON.stringify(stats, null, 2);
  const overlapsText = overlaps.length
    ? JSON.stringify(overlaps.slice(0, 50), null, 2)
    : 'No overlaps detected.';

  const matchResultText = formatMatchResult(matchData);
  const playerPerfText = formatPlayerPerformance(ktxstats, teamName);
  const itemControlText = formatItemControl(ktxstats, teamName);
  const mapContextText = await formatMapContext(mapName);

  // Format intermission context
  let intermissionText = '';
  if (intermissionTimelines && Object.keys(intermissionTimelines).length) {
    const intermissionLines = ['## Between-Map Discussion'];
    for (const [label, entries] of Object.entries(intermissionTimelines)) {
      if (entries.length) {
        intermissionLines.push(`\n### ${label}`);
        intermissionLines.push(formatTimeline(entries, 200));
      }
    }
    intermissionText = intermissionLines.join('\n');
  }

  const analysisSections = await buildAnalysisSections(!!intermissionText);

  // Build system prompt with whisper corrections context
  const commsContext = await formatWhisperCorrections();
  const systemPrompt = SYSTEM_PROMPT.replace('{commsContext}', commsContext);

  // Build analysis prompt
  const analysisPrompt = ANALYSIS_PROMPT_BASE
    .replace('{mapName}', mapName)
    .replace('{mapContextSection}', mapContextText)
    .replace('{matchResultSection}', matchResultText)
    .replace('{playerPerformanceSection}', playerPerfText)
    .replace('{itemControlSection}', itemControlText)
    .replace('{stats}', statsText)
    .replace('{overlaps}', overlapsText)
    .replace('{timeline}', timelineText)
    .replace('{intermissionSection}', intermissionText)
    .replace('{analysisSections}', analysisSections);

  // Call Claude
  const client = new Anthropic({ apiKey });

  const response = await client.messages.create({
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    messages: [{ role: 'user', content: analysisPrompt }],
  });

  const report = response.content[0].type === 'text' ? response.content[0].text : '';

  logger.info('Claude analysis complete', {
    mapName,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  });

  return {
    report,
    meta: {
      model,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      timelineEntries: timeline.length,
      overlapEvents: overlaps.length,
      hasMatchData: matchData !== undefined,
      hasKtxstats: ktxstats !== undefined,
    },
  };
}
