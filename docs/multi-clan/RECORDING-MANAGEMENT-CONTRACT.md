# Recording Management — Cross-Project Contract

> Extends the Voice Replay Multi-Clan contract with recording management features:
> series-grouped cards UI, deletion (Firebase + quad server), downloads, per-map privacy.
> Reference copies should be placed in each project's `docs/multi-clan/` folder.

---

## Overview

Team leaders can manage their voice recordings through a redesigned cards UI in the team management modal. Recordings are grouped into series by opponent, with expandable per-map detail. Leaders can toggle visibility, download recordings, and delete them (with cross-system cleanup).

**Key principles:**
- Source recordings (full Discord sessions) are deleted automatically after pipeline upload
- Sliced per-map audio exists in two places: Firebase Storage + quad server local disk
- Deletion from MatchScheduler removes Firebase copies immediately, then requests quad server cleanup async
- Downloads are client-side (JSZip) — no server-side zip generation
- GDPR compliance: users can request full deletion, audit trail via `deletionRequests` collection

---

## Schema Changes

### Extended: `/voiceRecordings/{demoSha256}`

New fields added to the existing document (quad writes these at upload time):

```typescript
interface VoiceRecordingDocument {
  // --- Existing fields (unchanged) ---
  demoSha256: string;
  teamId: string;
  teamTag: string;
  visibility: 'public' | 'private';
  source: 'firebase_storage';
  tracks: VoiceTrack[];
  mapName: string;
  recordedAt: Timestamp;
  uploadedAt: Timestamp;
  uploadedBy: string;
  trackCount: number;

  // --- NEW fields ---
  sessionId: string;                 // Recording session ULID (from session_metadata.json recording_id)
                                     // Groups maps that came from the same Discord voice session

  opponentTag: string;               // Opponent team name from Hub API (e.g., "pol", "oeks")
                                     // Lowercase. Used for series grouping within a session

  teamFrags: number;                 // Our team's total frags for this map
  opponentFrags: number;             // Opponent's total frags for this map

  gameId: number;                    // QW Hub game ID — cross-reference for stats/demo lookup

  mapOrder: number;                  // 0-based index of this map within the session's segments
                                     // Used for sorting maps chronologically within a series
}
```

**Source of new fields at upload time:**

| Field | Source | Example |
|-------|--------|---------|
| `sessionId` | `sessionMetadata.recording_id` (ULID) | `"01JKX1234567890ABCDEF"` |
| `opponentTag` | `segment.matchData.teams` — the team that isn't ours | `"pol"` |
| `teamFrags` | `segment.matchData.teams[ours].frags` | `312` |
| `opponentFrags` | `segment.matchData.teams[theirs].frags` | `287` |
| `gameId` | `segment.matchData.gameId` | `847291` |
| `mapOrder` | Index of segment in the session's paired matches | `0` |

**Determining "our" team vs opponent:** quad already knows `teamTag` from the bot registration. Match `teamTag` against `matchData.teams[].name` (case-insensitive). The other team is the opponent.

---

### New Collection: `/deletionRequests/{requestId}`

Coordinates deletion across Firebase and quad server storage.

```typescript
interface DeletionRequestDocument {
  requestId: string;                 // Document ID (auto-generated)
  demoSha256: string;                // Which recording to delete
  teamId: string;                    // Team that owns the recording
  sessionId: string;                 // Session the recording belongs to (for quad local path lookup)
  mapName: string;                   // Map name (for logging/audit)

  requestedBy: string;               // Firebase UID of the team leader
  requestedAt: Timestamp;            // When deletion was requested

  // Quad fills these in after processing
  status: 'pending' | 'completed' | 'failed';
  completedAt: Timestamp | null;
  error: string | null;              // If status == 'failed', why
}
```

**Lifecycle:**
1. MatchScheduler Cloud Function creates doc with `status: 'pending'`
2. quad Firestore listener picks it up
3. quad deletes local files: `recordings/{sessionId}/processed/{segmentDir}/audio/`
4. quad updates doc: `status: 'completed'`, `completedAt: now`
5. If quad can't find local files (already cleaned up), still mark `completed`

**Firestore Rules:**
```
match /deletionRequests/{requestId} {
  // Team leaders can read their own team's deletion requests (for status display)
  allow read: if request.auth != null
    && resource.data.teamId in
       get(/databases/$(database)/documents/users/$(request.auth.uid)).data.teams;

  // All writes via Cloud Function (create) or Admin SDK (quad status update)
  allow write: if false;
}
```

---

## Cloud Function: `deleteRecording`

New callable Cloud Function following the same pattern as `updateRecordingVisibility`.

```
Input:  { demoSha256: string }
Auth:   Must be authenticated, must be team leader
```

**Steps:**
1. Validate auth + input
2. Read `voiceRecordings/{demoSha256}` — get teamId, tracks[], sessionId, mapName
3. Verify caller is leader of that team (same check as updateRecordingVisibility)
4. Delete all Storage files: for each track, `bucket.file(track.storagePath).delete()`
5. Delete Firestore doc: `voiceRecordings/{demoSha256}.delete()`
6. Create `deletionRequests/{auto}` doc with status: 'pending'
7. Return `{ success: true }`

**Error handling:** If Storage deletion partially fails (some files already gone), continue with remaining files. The Firestore doc deletion and deletionRequest creation should still proceed.

---

## Download Format

### Per-Map Zip (atomic unit)

```
dm2_sr-vs-pol_2026-02-14.zip
├── ParadokS.ogg
├── razor.ogg
├── zero.ogg
├── TheChosenOne.ogg
└── manifest.json
```

### Per-Series Zip (wrapper)

```
sr-vs-pol_2026-02-14.zip
├── map1_dm2.zip
├── map2_e1m2.zip
└── map3_phantombase.zip
```

Zip of zips. Each inner zip is directly usable in the offline replay player as a drop-in.

### manifest.json Schema

Included in each per-map zip. Same data the online player uses — one schema, two contexts.

```json
{
  "version": 1,
  "demoSha256": "a1b2c3d4...",
  "gameId": 847291,
  "map": "dm2",
  "recordedAt": "2026-02-14T20:15:00.000Z",
  "teams": {
    "home": { "tag": "sr", "name": "Slackers", "frags": 312 },
    "away": { "tag": "pol", "name": "pol", "frags": 287 }
  },
  "tracks": [
    { "playerName": "ParadokS", "fileName": "ParadokS.ogg", "duration": 1205.3 },
    { "playerName": "razor", "fileName": "razor.ogg", "duration": 1205.3 },
    { "playerName": "zero", "fileName": "zero.ogg", "duration": 1205.3 },
    { "playerName": "TheChosenOne", "fileName": "TheChosenOne.ogg", "duration": 1205.3 }
  ],
  "offset": 0
}
```

**Note:** Files in the zip use `playerName` (human-readable) not `discordUserId` (internal). The manifest maps names to filenames for the offline player.

### Client-Side Implementation

- Library: JSZip (already common in web apps, ~100KB gzipped)
- Fetch .ogg files from Firebase Storage URLs (already public-read)
- Build manifest.json from Firestore doc data
- Per-map zip: fetch tracks + build manifest + zip + trigger download
- Per-series zip: build each map zip blob, wrap in outer zip + trigger download
- Show progress indicator ("Preparing download... 3/4 tracks")

---

## UI: Recording Cards

### Location

Team Management Modal → Recordings tab (replaces current flat list)

### Series Card (collapsed)

```
┌────────────────────────────────────────────────────────────┐
│ 14 Feb   [logo] sr  vs  pol [logo]   1-2    🔒  ⬇️  🗑️  ▼ │
└────────────────────────────────────────────────────────────┘
```

| Element | Source | Notes |
|---------|--------|-------|
| Date | `recordedAt` (earliest map in series) | Format: "14 Feb" |
| Team logos | Existing team logo system | Home team always on left |
| Team names | `teamTag` + `opponentTag` | |
| Score | Count maps where `teamFrags > opponentFrags` | e.g., "1-2" means we won 1 map, they won 2 |
| Privacy toggle | Batch-toggles all maps in series | Calls `updateRecordingVisibility` for each |
| Download | Downloads series zip | All maps bundled |
| Delete | Deletes all maps in series | Confirmation dialog first |
| Expand arrow | Toggles per-map detail | |

### Series Card (expanded)

```
┌────────────────────────────────────────────────────────────┐
│ 14 Feb   [logo] sr  vs  pol [logo]   1-2    🔒  ⬇️  🗑️  ▲ │
│                                                            │
│   dm2         4 tracks   12-8    🔒 Public   ⬇️  🗑️       │
│   e1m2        4 tracks   8-12   🔒 Private  ⬇️  🗑️       │
│   schloss     4 tracks   6-14   🔒 Private  ⬇️  🗑️       │
└────────────────────────────────────────────────────────────┘
```

| Element | Source | Notes |
|---------|--------|-------|
| Map name | `mapName` | Bold |
| Track count | `trackCount` | "{n} tracks" |
| Map score | `teamFrags`-`opponentFrags` | Per-map frag score |
| Privacy toggle | Per-map `visibility` | Independent of series default |
| Download | Downloads single map zip | |
| Delete | Deletes single map | Confirmation dialog |

### Series Grouping Logic (client-side)

```javascript
// Input: array of voiceRecording docs for the team
// Output: grouped series

function groupIntoSeries(recordings) {
  // Group by sessionId + opponentTag
  const groups = {};
  for (const rec of recordings) {
    const key = `${rec.sessionId}_${rec.opponentTag}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(rec);
  }

  // Sort maps within each series by mapOrder
  for (const series of Object.values(groups)) {
    series.sort((a, b) => a.mapOrder - b.mapOrder);
  }

  // Sort series by date (newest first)
  return Object.values(groups)
    .sort((a, b) => b[0].recordedAt - a[0].recordedAt);
}
```

### Legacy Recordings (no sessionId)

For the 10 existing recordings before backfill, or if backfill hasn't run yet:
- Each recording becomes its own single-map "series"
- Display as: `14 Feb  sr  dm2  4 tracks  [controls]` (no opponent info)
- After backfill, they appear in proper series groups

---

## quad Changes

### 1. Write Additional Fields at Upload Time

In `voice-uploader.ts`, add the new fields to the Firestore document write.

**Function signature change** — `uploadVoiceRecordings` currently receives `(segments, teamTag, guildId)`.
Add `sessionId` parameter: `(segments, teamTag, guildId, sessionId)`.
In `pipeline.ts`, pass `session.recording_id` (already available there).

**Segment data already available** — each `SegmentMetadata` has:
- `segment.index` → use as `mapOrder`
- `segment.gameId` → use directly
- `segment.matchData.teams: HubTeam[]` → `{ name: string, frags: number }[]`

```typescript
// Determine our team vs opponent from matchData.teams
const ourTeam = matchData.teams.find(t =>
  t.name.toLowerCase() === teamTag.toLowerCase()
);
const opponentTeam = matchData.teams.find(t => t !== ourTeam);

const doc = {
  // ...existing fields...

  // NEW
  sessionId,                                                  // from function parameter
  opponentTag: opponentTeam?.name?.toLowerCase() || 'unknown',
  teamFrags: ourTeam?.frags || 0,
  opponentFrags: opponentTeam?.frags || 0,
  gameId: segment.gameId,                                     // already on SegmentMetadata
  mapOrder: segment.index,                                    // already on SegmentMetadata
};
```

### 2. Post-Upload Cleanup of Source Recordings

After the fast pipeline completes successfully and all segments are uploaded:
- Delete the raw session audio files: `recordings/{sessionId}/*.ogg`
- Keep `session_metadata.json` (small, useful for debugging)
- Keep `processed/` directory (sliced outputs, needed until deletionRequest)
- Log what was cleaned up

```typescript
// In pipeline.ts, after uploadVoiceRecordings() succeeds
async function cleanupSourceRecordings(sessionDir: string) {
  const files = await fs.readdir(sessionDir);
  for (const file of files) {
    if (file.endsWith('.ogg')) {
      await fs.unlink(path.join(sessionDir, file));
      logger.info(`Cleaned up source recording: ${file}`);
    }
  }
}
```

**Only clean up if upload was successful** (uploaded > 0, or no segments to upload). Don't clean up on pipeline failure — the source recordings are needed for retry.

### 3. Deletion Request Listener

New Firestore listener in quad for the `deletionRequests` collection:

```typescript
// Listen for pending deletion requests for our registered guilds
db.collection('deletionRequests')
  .where('status', '==', 'pending')
  .onSnapshot(snapshot => {
    for (const change of snapshot.docChanges()) {
      if (change.type === 'added') {
        handleDeletionRequest(change.doc);
      }
    }
  });

async function handleDeletionRequest(doc) {
  const { demoSha256, sessionId, teamId } = doc.data();

  // Find and delete local processed files for this demo
  // Look in: recordings/{sessionId}/processed/*/
  // Match segment directories containing this demoSha256 in their metadata
  // Delete the segment directory (audio/ + transcripts/ + analysis/)

  await doc.ref.update({
    status: 'completed',
    completedAt: new Date(),
  });
}
```

**Scope:** Only listens for requests matching guilds this bot instance serves. For the central bot, this is all registered guilds. Self-hosted instances filter by their own guildId.

---

## Backfill Script

One-time script to populate new fields on the 10 existing `voiceRecordings` documents.

**Strategy:**
1. Query all `voiceRecordings` docs where `sessionId` is missing
2. For each, use `gameId` or `demoSha256` to query QW Hub API for match data
3. Populate: `opponentTag`, `teamFrags`, `opponentFrags`, `gameId`
4. For `sessionId`: group by timestamp proximity (maps within 2 hours = same session)
5. For `mapOrder`: sort by `recordedAt` within session, assign 0-based index

**Can run from either project** (anything with Firebase Admin SDK access). Suggested: run from quad's existing tooling since it already has Hub API client.

---

## Phase Plan

| Phase | Project | Scope | Depends on |
|-------|---------|-------|------------|
| **R1** | quad | Write new fields to Firestore at upload time | — |
| **R2** | quad | Post-upload cleanup of source recordings | — |
| **R3** | MatchScheduler | Recording cards UI with series grouping | R1 (for new field schema) |
| **R4** | MatchScheduler | `deleteRecording` Cloud Function + UI delete flow | — |
| **R5** | quad | `deletionRequests` listener + local file cleanup | R4 (creates the requests) |
| **R6** | MatchScheduler | Download flow (JSZip per-map + series bundling) | R3 (UI in place) |
| **R7** | Either | Backfill script for existing recordings | R1 (schema finalized) |

**Parallelism:** R1+R2 (quad) and R4 (MatchScheduler Cloud Function) can run in parallel. R3 can start with mock data before R1 lands. R5 and R6 are independent of each other.

---

## Resolved Decisions

1. **Team logos for opponents**: Logos are available in Firebase/Firestore for registered teams. Show opponent logo when they're a registered team, fallback to text-only for unknown opponents.
2. **Roster member access**: Roster members can view the recordings tab and download. Only team leader gets delete and privacy toggle controls. UI hides those controls for non-leaders.
3. **Bulk operations**: Skipped for MVP. Per-series and per-map controls are sufficient.
4. **Confirmation dialog for delete**: Informative modal showing what will be deleted (map name, track count, date). For series delete: list all maps included. Cancel/Delete buttons. "This cannot be undone."
