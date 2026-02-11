/**
 * Quick test: run the fast pipeline against a local recording session.
 * Usage: npx tsx scripts/test-fast-pipeline.ts [session_id]
 */

import { runFastPipeline, resolveSessionDir, loadSessionMetadata } from '../src/modules/processing/pipeline.js';
import type { ProcessingConfig } from '../src/core/config.js';

const RECORDING_DIR = './recordings';
const sessionIdArg = process.argv[2] || null;

const config: ProcessingConfig = {
  anthropicApiKey: '',
  whisperModel: 'small',
  playerQuery: 'paradoks',
  playerNameMap: {
    paradoks: 'ParadokS',
    zerohero5954: 'zero',
    fs_razor: 'Razor',
    grisling2947: 'grisling',
  },
  processingAuto: false,
  processingTranscribe: false,
  processingIntermissions: true,
};

async function main() {
  const sessionDir = await resolveSessionDir(RECORDING_DIR, sessionIdArg);
  if (!sessionDir) {
    console.error('No session found');
    process.exit(1);
  }

  const meta = await loadSessionMetadata(sessionDir);
  console.log(`\nSession: ${meta.recording_id}`);
  console.log(`Time: ${meta.recording_start_time} → ${meta.recording_end_time}`);
  console.log(`Tracks: ${meta.tracks.length} (${meta.tracks.map(t => t.discord_display_name).join(', ')})`);
  console.log(`Dir: ${sessionDir}\n`);

  console.log('Running fast pipeline...\n');
  const result = await runFastPipeline(sessionDir, config);

  console.log('\n=== RESULTS ===');
  console.log(`Matches paired: ${result.pairings.length}`);
  console.log(`Segments split: ${result.segments.length}`);
  console.log(`Intermissions: ${result.intermissions.length}`);
  console.log('\n' + result.summary);

  for (const seg of result.segments) {
    console.log(`\nSegment: ${seg.dirName}`);
    console.log(`  Map: ${seg.map}`);
    console.log(`  Time: ${seg.startTime.toFixed(1)}s → ${seg.endTime.toFixed(1)}s`);
    console.log(`  Players: ${seg.players.map(p => `${p.name} (${p.duration.toFixed(0)}s)`).join(', ')}`);
  }

  for (const inter of result.intermissions) {
    console.log(`\nIntermission: ${inter.dirName}`);
    console.log(`  Label: ${inter.label}`);
    console.log(`  Time: ${inter.startTime.toFixed(1)}s → ${inter.endTime.toFixed(1)}s`);
    console.log(`  Duration: ${((inter.endTime - inter.startTime) / 60).toFixed(1)} min`);
  }
}

main().catch((err) => {
  console.error('Pipeline failed:', err);
  process.exit(1);
});
