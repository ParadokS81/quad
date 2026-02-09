# Recording Module

Per-speaker voice recording from Discord voice channels. This is the first and currently only module in Quad.

## Scope
This module does ONE thing: capture per-user Opus audio from Discord and write it as OGG/Opus files to disk, along with a `session_metadata.json`. No transcription, no analysis, no API calls.

## Files
- `index.ts` — BotModule export (commands, events, lifecycle hooks)
- `commands/record.ts` — `/record start` and `/record stop` slash command handlers
- `session.ts` — `RecordingSession` class: manages one recording session (tracks, timing, output dir)
- `track.ts` — `UserTrack` class: per-user OGG stream pipeline (Opus → OGG → file)
- `silence.ts` — Silent Opus frame generation + caching
- `metadata.ts` — Writes `session_metadata.json` at end of session

## Key Patterns
- `receiver.subscribe(userId, { end: { behavior: EndBehaviorType.Manual } })` — one long-lived stream per user
- `pipeline(opusStream, oggStream, fileStream)` — Node.js stream pipeline, no buffering
- Silent Opus frames inserted on a 20ms timer when no audio packet received
- Late-joining users get silence prepended to align with recording start time

## What NOT to do
- Never transcode Opus to another codec
- Never buffer audio in memory — always stream to disk
- Never create per-utterance files — one continuous OGG per speaker
- Never modify core/ files from this module
- Never import from other modules (modules are independent)

## prism-media usage
```typescript
import prism from 'prism-media';
// Use v1.3.5 API — v2 alpha is broken
const oggStream = new prism.opus.OggLogicalBitstream({
  opusHead: new prism.opus.OpusHead({
    channelCount: 2,
    sampleRate: 48000,
  }),
  pageSizeControl: { maxPackets: 10 },
});
```
