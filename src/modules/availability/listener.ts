/**
 * Firestore listeners for the availability module.
 *
 * On startup, queries all active botRegistrations with a scheduleChannelId
 * and starts per-team listeners. Each team gets:
 * - An availability document listener (real-time, debounced re-render)
 * - A registration document listener (detects channel changes, teardown)
 * - A scheduled matches poll (every 5 minutes)
 *
 * On each render: weekly rollover check, team info refresh, canvas render,
 * and Discord message post/update.
 */

import { type Client } from 'discord.js';
import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import { type AvailabilityData, type TeamInfo, type RosterMember } from './types.js';
import { getCurrentWeekId, getWeekDates } from './time.js';
import { renderGrid } from './renderer.js';
import { buildMatchLinksEmbed, formatScheduledDate } from './embed.js';
import { postOrRecoverMessage, updateMessage, updateMatchesMessage } from './message.js';

// ── Per-team state ───────────────────────────────────────────────────────────

interface TeamState {
    teamId: string;
    channelId: string;
    messageId: string | null;
    weekId: string;
    availabilityUnsub: () => void;
    registrationUnsub: () => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    lastAvailability: AvailabilityData | null;
    teamInfo: TeamInfo | null;
    scheduledMatches: Array<{ slotId: string; opponentTag: string; opponentId: string }>;
    activeProposals: Array<{ opponentTag: string; viableSlots: number }>;
    matchesMessageId: string | null;
}

const activeTeams = new Map<string, TeamState>();
let firestoreDb: Firestore | null = null;
let botClient: Client | null = null;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Start listeners for all active teams with a configured schedule channel.
 * Called from module onReady.
 */
export async function startAllListeners(db: Firestore, client: Client): Promise<void> {
    firestoreDb = db;
    botClient = client;

    const snap = await db.collection('botRegistrations')
        .where('status', '==', 'active')
        .get();

    for (const doc of snap.docs) {
        const data = doc.data();
        const teamId = doc.id;
        const channelId = data.scheduleChannelId as string | null;
        const messageId = data.scheduleMessageId as string | null;

        if (!channelId) continue;

        try {
            await startTeamListener(teamId, channelId, messageId);
        } catch (err) {
            logger.error('Failed to start availability listener for team', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Availability listeners started', { teamCount: activeTeams.size });
}

/**
 * Stop all listeners. Called from module onShutdown.
 */
export function stopAllListeners(): void {
    for (const teamId of [...activeTeams.keys()]) {
        teardownTeam(teamId);
    }
    firestoreDb = null;
    botClient = null;
    logger.info('All availability listeners stopped');
}

/**
 * Get cached availability data for a team (used by interaction handlers).
 * Returns null if team not tracked or no data yet.
 */
export function getTeamAvailability(teamId: string): AvailabilityData | null {
    return activeTeams.get(teamId)?.lastAvailability ?? null;
}

// ── Per-team lifecycle ───────────────────────────────────────────────────────

async function startTeamListener(
    teamId: string,
    channelId: string,
    storedMessageId: string | null,
): Promise<void> {
    if (!firestoreDb || !botClient) return;

    // Teardown existing listener if any
    if (activeTeams.has(teamId)) {
        teardownTeam(teamId);
    }

    const weekId = getCurrentWeekId();

    const state: TeamState = {
        teamId,
        channelId,
        messageId: storedMessageId,
        weekId,
        availabilityUnsub: () => {},
        registrationUnsub: () => {},
        pollTimer: null,
        debounceTimer: null,
        lastAvailability: null,
        teamInfo: null,
        scheduledMatches: [],
        activeProposals: [],
        matchesMessageId: null,
    };

    activeTeams.set(teamId, state);

    // Fetch initial team info before first render
    state.teamInfo = await fetchTeamInfo(teamId);

    // Subscribe to availability changes
    state.availabilityUnsub = subscribeAvailability(teamId, weekId);

    // Subscribe to registration config changes
    state.registrationUnsub = subscribeRegistration(teamId);

    // Poll scheduled matches immediately + every 5 minutes
    await pollScheduledMatches(teamId);
    state.pollTimer = setInterval(() => {
        pollScheduledMatches(teamId).catch(err => {
            logger.warn('Scheduled matches poll failed', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        });
    }, 5 * 60 * 1000);

    logger.info('Availability listener started for team', { teamId, channelId, weekId });
}

function teardownTeam(teamId: string): void {
    const state = activeTeams.get(teamId);
    if (!state) return;

    state.availabilityUnsub();
    state.registrationUnsub();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);

    activeTeams.delete(teamId);
    logger.info('Availability listener torn down', { teamId });
}

// ── Firestore subscriptions ─────────────────────────────────────────────────

function subscribeAvailability(teamId: string, weekId: string): () => void {
    if (!firestoreDb) return () => {};

    const docId = `${teamId}_${weekId}`;
    return firestoreDb.collection('availability').doc(docId)
        .onSnapshot(
            (snap) => {
                const state = activeTeams.get(teamId);
                if (!state) return;

                if (snap.exists) {
                    state.lastAvailability = snap.data() as AvailabilityData;
                } else {
                    state.lastAvailability = null;
                }
                scheduleRender(teamId);
            },
            (err) => {
                logger.error('Availability listener error', {
                    teamId, weekId, error: err instanceof Error ? err.message : String(err),
                });
            },
        );
}

function subscribeRegistration(teamId: string): () => void {
    if (!firestoreDb) return () => {};

    return firestoreDb.collection('botRegistrations').doc(teamId)
        .onSnapshot(
            (snap) => {
                if (!snap.exists) return;

                const data = snap.data()!;
                const currentState = activeTeams.get(teamId);
                if (!currentState) return;

                // Team disconnected or deactivated
                if (data.status === 'disconnecting' || data.status === 'inactive') {
                    teardownTeam(teamId);
                    return;
                }

                const newChannelId = data.scheduleChannelId as string | null;

                // Channel removed
                if (!newChannelId) {
                    teardownTeam(teamId);
                    return;
                }

                // Channel changed — restart with new channel
                if (newChannelId !== currentState.channelId) {
                    teardownTeam(teamId);
                    startTeamListener(teamId, newChannelId, null).catch(err => {
                        logger.error('Failed to restart listener after channel change', {
                            teamId, error: err instanceof Error ? err.message : String(err),
                        });
                    });
                }
            },
            (err) => {
                logger.error('Registration listener error', {
                    teamId, error: err instanceof Error ? err.message : String(err),
                });
            },
        );
}

// ── Debounced rendering ──────────────────────────────────────────────────────

function scheduleRender(teamId: string): void {
    const state = activeTeams.get(teamId);
    if (!state) return;

    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
        renderAndUpdateMessage(teamId).catch(err => {
            logger.error('Render failed', {
                teamId, error: err instanceof Error ? err.message : String(err),
            });
        });
    }, 3000);
}

async function renderAndUpdateMessage(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb || !botClient) return;

    // Weekly rollover check
    const currentWeekId = getCurrentWeekId();
    if (currentWeekId !== state.weekId) {
        logger.info('Week rollover detected', { teamId, oldWeek: state.weekId, newWeek: currentWeekId });
        state.availabilityUnsub();
        state.weekId = currentWeekId;
        state.lastAvailability = null;
        state.availabilityUnsub = subscribeAvailability(teamId, currentWeekId);
        // New snapshot will trigger another render
        return;
    }

    // Refresh team info (team data changes rarely, but refresh each render to stay current)
    const freshTeamInfo = await fetchTeamInfo(teamId);
    if (freshTeamInfo) {
        state.teamInfo = freshTeamInfo;
    }

    if (!state.teamInfo) {
        logger.warn('No team info available, skipping render', { teamId });
        return;
    }

    const now = new Date();
    const weekDates = getWeekDates(state.weekId);

    // Render canvas grid
    let imageBuffer: Buffer;
    try {
        imageBuffer = await renderGrid({
            teamTag: state.teamInfo.teamTag,
            weekId: state.weekId,
            weekDates,
            slots: state.lastAvailability?.slots ?? {},
            unavailable: state.lastAvailability?.unavailable,
            roster: state.teamInfo.roster,
            scheduledMatches: state.scheduledMatches,
            now,
        });
    } catch (err) {
        logger.error('Failed to render schedule grid', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // Post or update the grid message (image + dropdown only)
    try {
        if (state.messageId) {
            const result = await updateMessage(
                botClient, state.channelId, state.messageId, teamId, imageBuffer,
            );
            if (result === null) {
                const newId = await postOrRecoverMessage(
                    botClient, state.channelId, teamId, imageBuffer,
                );
                state.messageId = newId;
                // Grid was re-posted — old matches message is now above it, delete it
                state.matchesMessageId = null;
            }
        } else {
            const newId = await postOrRecoverMessage(
                botClient, state.channelId, teamId, imageBuffer,
            );
            state.messageId = newId;
        }
    } catch (err) {
        logger.error('Failed to update schedule message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    // Post or update the matches message (separate, below the grid)
    try {
        const matchLinks = state.scheduledMatches.map(m => ({
            opponentTag: m.opponentTag,
            opponentId: m.opponentId,
            scheduledDate: formatScheduledDate(m.slotId, state.weekId),
        }));
        const embed = matchLinks.length > 0
            ? buildMatchLinksEmbed(teamId, matchLinks)
            : null;

        state.matchesMessageId = await updateMatchesMessage(
            botClient, state.channelId, state.matchesMessageId, embed,
        );
    } catch (err) {
        logger.error('Failed to update matches message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch team info: tag, name, and roster (displayName + initials per member).
 * Reads teams/{teamId} for metadata and users collection for roster.
 */
async function fetchTeamInfo(teamId: string): Promise<TeamInfo | null> {
    if (!firestoreDb) return null;

    try {
        const [teamDoc, usersSnap] = await Promise.all([
            firestoreDb.collection('teams').doc(teamId).get(),
            firestoreDb.collection('users').where(`teams.${teamId}`, '==', true).get(),
        ]);

        if (!teamDoc.exists) {
            logger.warn('Team document not found', { teamId });
            return null;
        }

        const data = teamDoc.data()!;
        const teamTag = String(data.teamTag ?? data.tag ?? '');
        const teamName = String(data.teamName ?? data.name ?? '');

        const roster: Record<string, RosterMember> = {};
        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const displayName = String(userData.displayName ?? 'Unknown');
            const initials = String(
                userData.initials ?? displayName.slice(0, 2).toUpperCase(),
            );
            roster[userDoc.id] = { displayName, initials };
        }

        return { teamId, teamTag, teamName, roster };
    } catch (err) {
        logger.error('Failed to fetch team info', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Poll scheduled matches and active proposals for a team.
 * Updates state.scheduledMatches and state.activeProposals.
 */
async function pollScheduledMatches(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb) return;

    try {
        // Scheduled matches for this team's current week
        const matchesSnap = await firestoreDb.collection('scheduledMatches')
            .where('blockedTeams', 'array-contains', teamId)
            .where('status', '==', 'upcoming')
            .where('weekId', '==', state.weekId)
            .get();

        const prevMatchCount = state.scheduledMatches.length;

        const scheduledMatches: Array<{ slotId: string; opponentTag: string; opponentId: string }> = [];
        for (const doc of matchesSnap.docs) {
            const data = doc.data();
            // Schema uses teamA/teamB — opponent is whichever side isn't us
            const isTeamA = data.teamAId === teamId;
            const opponentTag = isTeamA
                ? String(data.teamBTag ?? '?')
                : String(data.teamATag ?? '?');
            const opponentId = isTeamA
                ? String(data.teamBId ?? '')
                : String(data.teamAId ?? '');

            if (data.slotId) {
                scheduledMatches.push({ slotId: String(data.slotId), opponentTag, opponentId });
            }
        }

        // Sort chronologically by slotId time (e.g., "fri_2030" before "sun_2200")
        const dayOrder: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
        scheduledMatches.sort((a, b) => {
            const [dayA, timeA = ''] = a.slotId.split('_');
            const [dayB, timeB = ''] = b.slotId.split('_');
            const dayCmp = (dayOrder[dayA] ?? 9) - (dayOrder[dayB] ?? 9);
            return dayCmp !== 0 ? dayCmp : timeA.localeCompare(timeB);
        });
        state.scheduledMatches = scheduledMatches;

        // Active proposals (Firestore doesn't support OR across fields, two queries)
        const [proposerSnap, opponentSnap] = await Promise.all([
            firestoreDb.collection('matchProposals')
                .where('proposerTeamId', '==', teamId)
                .where('status', '==', 'active')
                .get(),
            firestoreDb.collection('matchProposals')
                .where('opponentTeamId', '==', teamId)
                .where('status', '==', 'active')
                .get(),
        ]);

        // Merge and deduplicate
        const seenIds = new Set<string>();
        const activeProposals: Array<{ opponentTag: string; viableSlots: number }> = [];

        for (const snap of [proposerSnap, opponentSnap]) {
            for (const doc of snap.docs) {
                if (seenIds.has(doc.id)) continue;
                seenIds.add(doc.id);

                const data = doc.data();
                const opponentTag = data.proposerTeamId === teamId
                    ? String(data.opponentTeamTag ?? '?')
                    : String(data.proposerTeamTag ?? '?');
                const viableSlots = Array.isArray(data.confirmedSlots)
                    ? data.confirmedSlots.length
                    : 0;

                activeProposals.push({ opponentTag, viableSlots });
            }
        }

        state.activeProposals = activeProposals;

        // Trigger re-render if matches/proposals changed
        if (scheduledMatches.length !== prevMatchCount || activeProposals.length > 0) {
            scheduleRender(teamId);
        }
    } catch (err) {
        logger.warn('Failed to poll scheduled matches/proposals', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}
