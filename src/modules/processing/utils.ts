/**
 * Shared utilities for the processing module.
 *
 * YAML knowledge loader, player name resolution, Whisper prompt builder.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Knowledge dir lives under src/ (YAML files aren't compiled by tsc).
// From both dist/modules/processing/ and src/modules/processing/,
// going up 3 levels reaches the project root.
const PROJECT_ROOT = join(__dirname, '..', '..', '..');
const KNOWLEDGE_DIR = join(PROJECT_ROOT, 'src', 'modules', 'processing', 'knowledge');

/**
 * Load and parse a YAML file.
 */
export async function loadYaml<T = Record<string, unknown>>(filePath: string): Promise<T | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return yaml.load(content) as T;
  } catch {
    return null;
  }
}

/**
 * Load a YAML knowledge file by relative path within the knowledge directory.
 * @param relativePath e.g. "terminology/qw-glossary.yaml"
 */
export async function loadKnowledge<T = Record<string, unknown>>(relativePath: string): Promise<T | null> {
  return loadYaml<T>(join(KNOWLEDGE_DIR, relativePath));
}

/**
 * Resolve a player's display name for output files.
 *
 * Priority: playerNameMap > discordDisplayName > discordUsername
 */
export function resolvePlayerName(
  discordUsername: string | null | undefined,
  discordDisplayName: string | null | undefined,
  playerNameMap: Record<string, string>,
): string {
  if (discordUsername) {
    const mapped = playerNameMap[discordUsername.toLowerCase()];
    if (mapped) return mapped;
  }
  if (discordDisplayName) return discordDisplayName;
  return discordUsername || 'unknown';
}

/**
 * Extract player name from audio filename.
 * Format: "1-paradoks.ogg" -> "paradoks"
 */
export function getPlayerName(filename: string): string {
  const stem = filename.replace(/\.[^.]+$/, '');
  const parts = stem.split('-', 2);
  if (parts.length === 2 && /^\d+$/.test(parts[0])) {
    return parts[1];
  }
  return stem;
}

// Glossary type for the QW glossary YAML structure
interface QWGlossary {
  items?: Record<string, string[]>;
  actions?: string[];
  map_callouts?: Record<string, string[]>;
  known_player_names?: string[];
  whisper_corrections?: Array<{ misheard?: string; correct?: string; context?: string }>;
}

/**
 * Build a Whisper initial_prompt from the QW glossary.
 * Biases Whisper toward recognizing QW-specific vocabulary.
 */
export async function buildWhisperPrompt(mapName: string = ''): Promise<string> {
  const glossary = await loadKnowledge<QWGlossary>('terminology/qw-glossary.yaml');
  if (!glossary) return '';

  const terms: string[] = [];

  // Item names
  if (glossary.items) {
    for (const category of Object.values(glossary.items)) {
      if (Array.isArray(category)) {
        terms.push(...category);
      }
    }
  }

  // Action callouts
  if (Array.isArray(glossary.actions)) {
    terms.push(...glossary.actions);
  }

  // Map-specific callouts
  if (mapName && glossary.map_callouts) {
    const callouts = glossary.map_callouts[mapName];
    if (Array.isArray(callouts)) {
      terms.push(...callouts);
    }
  }

  // Known player names
  if (Array.isArray(glossary.known_player_names)) {
    terms.push(...glossary.known_player_names);
  }

  // Whisper corrections (prefer correct forms)
  if (Array.isArray(glossary.whisper_corrections)) {
    for (const c of glossary.whisper_corrections) {
      if (c.correct && c.correct !== 'unknown - needs verification') {
        terms.push(c.correct);
      }
    }
  }

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const t of terms) {
    if (!seen.has(t)) {
      seen.add(t);
      unique.push(t);
    }
  }

  return unique.join(', ');
}

/**
 * Format Whisper correction context for Claude's system prompt.
 */
export async function formatWhisperCorrections(): Promise<string> {
  const glossary = await loadKnowledge<QWGlossary>('terminology/qw-glossary.yaml');
  if (!glossary?.whisper_corrections) return '';

  const lines = ['Known transcription issues (Whisper misheard terms):'];
  for (const c of glossary.whisper_corrections) {
    if (c.misheard && c.correct) {
      lines.push(`- "${c.misheard}" should be "${c.correct}" (${c.context ?? ''})`);
    }
  }
  return lines.join('\n');
}