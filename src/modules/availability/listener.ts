/**
 * Firestore listeners for the availability module.
 *
 * On startup, queries all active botRegistrations with a scheduleChannelId
 * and starts per-team listeners. Each team gets:
 * - Two availability document listeners (current week + next week, debounced re-render)
 * - A registration document listener (detects channel changes, teardown)
 * - A scheduled matches poll (every 5 minutes, both weeks)
 *
 * On each render: weekly rollover check, team info refresh, canvas render for
 * both weeks, and Discord message post/update.
 */

import { type Client } from 'discord.js';
import { type Firestore } from 'firebase-admin/firestore';
import { logger } from '../../core/logger.js';
import {
    type AvailabilityData, type TeamInfo, type RosterMember,
    type ScheduledMatchDisplay, type ActiveProposalDisplay,
} from './types.js';
import { getCurrentWeekId, getNextWeekId, getWeekDates } from './time.js';
import { renderGrid } from './renderer.js';
import {
    renderMatchCard, renderProposalCard,
    type MatchCardInput, type ProposalCardInput,
} from './match-renderer.js';
import { buildMatchButton, buildProposalButton, formatScheduledDate } from './embed.js';
import { postOrRecoverMessage, updateMessage, syncCardMessages } from './message.js';
import { getTeamLogo, clearLogoCache } from './logo-cache.js';

// ── Per-team state ───────────────────────────────────────────────────────────

interface TeamState {
    teamId: string;
    channelId: string;
    // Current week
    messageId: string | null;
    weekId: string;
    availabilityUnsub: () => void;
    lastAvailability: AvailabilityData | null;
    scheduledMatches: ScheduledMatchDisplay[];
    // Next week
    nextWeekMessageId: string | null;
    nextWeekId: string;
    nextWeekUnsub: () => void;
    nextWeekAvailability: AvailabilityData | null;
    nextWeekMatches: ScheduledMatchDisplay[];
    // Shared
    registrationUnsub: () => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    teamInfo: TeamInfo | null;
    activeProposals: ActiveProposalDisplay[];
    matchMessageIds: string[];
    proposalMessageIds: string[];
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
        const nextWeekMessageId = (data.nextWeekMessageId as string | null) ?? null;
        const matchMessageIds = (data.matchMessageIds as string[] | undefined) ?? [];
        const proposalMessageIds = (data.proposalMessageIds as string[] | undefined) ?? [];

        if (!channelId) continue;

        try {
            await startTeamListener(teamId, channelId, messageId, nextWeekMessageId, matchMessageIds, proposalMessageIds);
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
    clearLogoCache();
    firestoreDb = null;
    botClient = null;
    logger.info('All availability listeners stopped');
}

/**
 * Get cached availability data for a team + week.
 * Returns null if team not tracked or no data yet.
 */
export function getAvailabilityForWeek(teamId: string, weekId: string): AvailabilityData | null {
    const state = activeTeams.get(teamId);
    if (!state) return null;
    if (weekId === state.weekId) return state.lastAvailability;
    if (weekId === state.nextWeekId) return state.nextWeekAvailability;
    return null;
}

// ── Per-team lifecycle ───────────────────────────────────────────────────────

export async function startTeamListener(
    teamId: string,
    channelId: string,
    storedMessageId: string | null,
    storedNextWeekMessageId: string | null = null,
    storedMatchMessageIds: string[] = [],
    storedProposalMessageIds: string[] = [],
): Promise<void> {
    if (!firestoreDb || !botClient) return;

    // Teardown existing listener if any
    if (activeTeams.has(teamId)) {
        teardownTeam(teamId);
    }

    const weekId = getCurrentWeekId();
    const nextWeekId = getNextWeekId();

    const state: TeamState = {
        teamId,
        channelId,
        // Current week
        messageId: storedMessageId,
        weekId,
        availabilityUnsub: () => {},
        lastAvailability: null,
        scheduledMatches: [],
        // Next week
        nextWeekMessageId: storedNextWeekMessageId,
        nextWeekId,
        nextWeekUnsub: () => {},
        nextWeekAvailability: null,
        nextWeekMatches: [],
        // Shared
        registrationUnsub: () => {},
        pollTimer: null,
        debounceTimer: null,
        teamInfo: null,
        activeProposals: [],
        matchMessageIds: storedMatchMessageIds,
        proposalMessageIds: storedProposalMessageIds,
    };

    activeTeams.set(teamId, state);

    // Fetch initial team info before first render
    state.teamInfo = await fetchTeamInfo(teamId);

    // Subscribe to availability changes for both weeks
    state.availabilityUnsub = subscribeAvailability(teamId, weekId, 'current');
    state.nextWeekUnsub = subscribeAvailability(teamId, nextWeekId, 'next');

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

    logger.info('Availability listener started for team', { teamId, channelId, weekId, nextWeekId });
}

function teardownTeam(teamId: string): void {
    const state = activeTeams.get(teamId);
    if (!state) return;

    state.availabilityUnsub();
    state.nextWeekUnsub();
    state.registrationUnsub();
    if (state.debounceTimer) clearTimeout(state.debounceTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);

    activeTeams.delete(teamId);
    logger.info('Availability listener torn down', { teamId });
}

// ── Firestore subscriptions ─────────────────────────────────────────────────

function subscribeAvailability(teamId: string, weekId: string, which: 'current' | 'next'): () => void {
    if (!firestoreDb) return () => {};

    const docId = `${teamId}_${weekId}`;
    return firestoreDb.collection('availability').doc(docId)
        .onSnapshot(
            (snap) => {
                const state = activeTeams.get(teamId);
                if (!state) return;

                const data = snap.exists ? snap.data() as AvailabilityData : null;
                if (which === 'current') {
                    state.lastAvailability = data;
                } else {
                    state.nextWeekAvailability = data;
                }
                scheduleRender(teamId);
            },
            (err) => {
                logger.error('Availability listener error', {
                    teamId, weekId, which, error: err instanceof Error ? err.message : String(err),
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
                    startTeamListener(teamId, newChannelId, null, null).catch(err => {
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
    const nextWeekId = getNextWeekId();

    if (currentWeekId !== state.weekId) {
        logger.info('Week rollover detected', {
            teamId, oldWeek: state.weekId, newWeek: currentWeekId,
        });
        // Current week rolled — resubscribe both
        state.availabilityUnsub();
        state.nextWeekUnsub();
        state.weekId = currentWeekId;
        state.nextWeekId = nextWeekId;
        state.lastAvailability = null;
        state.nextWeekAvailability = null;
        // Old next-week message becomes irrelevant (old current week grid)
        // — it will be updated with the new next-week data on next render
        state.availabilityUnsub = subscribeAvailability(teamId, currentWeekId, 'current');
        state.nextWeekUnsub = subscribeAvailability(teamId, nextWeekId, 'next');
        // New snapshots will trigger another render
        return;
    }

    // Next week ID might change without current week rolling (edge case at year boundary)
    if (nextWeekId !== state.nextWeekId) {
        state.nextWeekUnsub();
        state.nextWeekId = nextWeekId;
        state.nextWeekAvailability = null;
        state.nextWeekUnsub = subscribeAvailability(teamId, nextWeekId, 'next');
        return;
    }

    // Refresh team info
    const freshTeamInfo = await fetchTeamInfo(teamId);
    if (freshTeamInfo) {
        state.teamInfo = freshTeamInfo;
    }

    if (!state.teamInfo) {
        logger.warn('No team info available, skipping render', { teamId });
        return;
    }

    const now = new Date();

    // ── Render next week grid ──
    let nextWeekBuffer: Buffer;
    try {
        nextWeekBuffer = await renderGrid({
            teamTag: state.teamInfo.teamTag,
            weekId: state.nextWeekId,
            weekDates: getWeekDates(state.nextWeekId),
            slots: state.nextWeekAvailability?.slots ?? {},
            unavailable: state.nextWeekAvailability?.unavailable,
            roster: state.teamInfo.roster,
            scheduledMatches: state.nextWeekMatches,
            now,
        });
    } catch (err) {
        logger.error('Failed to render next week grid', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // ── Render current week grid ──
    let currentWeekBuffer: Buffer;
    try {
        currentWeekBuffer = await renderGrid({
            teamTag: state.teamInfo.teamTag,
            weekId: state.weekId,
            weekDates: getWeekDates(state.weekId),
            slots: state.lastAvailability?.slots ?? {},
            unavailable: state.lastAvailability?.unavailable,
            roster: state.teamInfo.roster,
            scheduledMatches: state.scheduledMatches,
            now,
        });
    } catch (err) {
        logger.error('Failed to render current week grid', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return;
    }

    // ── Post/update next week grid message (must be above current week) ──
    let nextWeekReposted = false;
    try {
        if (state.nextWeekMessageId) {
            const result = await updateMessage(
                botClient, state.channelId, state.nextWeekMessageId, teamId, nextWeekBuffer, true,
            );
            if (result === null) {
                const newId = await postOrRecoverMessage(
                    botClient, state.channelId, teamId, nextWeekBuffer, true,
                );
                state.nextWeekMessageId = newId;
                nextWeekReposted = true;
            }
        } else {
            const newId = await postOrRecoverMessage(
                botClient, state.channelId, teamId, nextWeekBuffer, true,
            );
            state.nextWeekMessageId = newId;
            nextWeekReposted = true;
        }
    } catch (err) {
        logger.error('Failed to update next week message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    // If next week grid was reposted, current week grid + cards are now above it — repost all
    if (nextWeekReposted) {
        // Delete existing current week message + all cards
        await deleteMessages(botClient, state.channelId, [
            ...(state.messageId ? [state.messageId] : []),
            ...state.matchMessageIds,
            ...state.proposalMessageIds,
        ]);
        state.messageId = null;
        state.matchMessageIds = [];
        state.proposalMessageIds = [];
    }

    // ── Post/update current week grid message ──
    let currentWeekReposted = false;
    try {
        if (state.messageId) {
            const result = await updateMessage(
                botClient, state.channelId, state.messageId, teamId, currentWeekBuffer, false,
            );
            if (result === null) {
                const newId = await postOrRecoverMessage(
                    botClient, state.channelId, teamId, currentWeekBuffer, false,
                );
                state.messageId = newId;
                currentWeekReposted = true;
            }
        } else {
            const newId = await postOrRecoverMessage(
                botClient, state.channelId, teamId, currentWeekBuffer, false,
            );
            state.messageId = newId;
            currentWeekReposted = true;
        }
    } catch (err) {
        logger.error('Failed to update current week message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    // If current week grid was reposted, cards are now above it — delete them
    if (currentWeekReposted && !nextWeekReposted) {
        await deleteMessages(botClient, state.channelId, [
            ...state.matchMessageIds,
            ...state.proposalMessageIds,
        ]);
        state.matchMessageIds = [];
        state.proposalMessageIds = [];
        await firestoreDb.collection('botRegistrations').doc(teamId).update({
            matchMessageIds: [],
            proposalMessageIds: [],
        });
    }

    // Persist message IDs if either grid was reposted
    if (nextWeekReposted || currentWeekReposted) {
        await firestoreDb.collection('botRegistrations').doc(teamId).update({
            nextWeekMessageId: state.nextWeekMessageId,
            scheduleMessageId: state.messageId,
            matchMessageIds: state.matchMessageIds,
            proposalMessageIds: state.proposalMessageIds,
        });
    }

    // ── Render match + proposal card messages ──
    // Combine both weeks' matches, sorted chronologically.
    try {
        const allMatches = [...state.scheduledMatches, ...state.nextWeekMatches];
        const matchCards: Array<{ buffer: Buffer; button: ReturnType<typeof buildMatchButton> }> = [];
        const proposalCards: Array<{ buffer: Buffer; button: ReturnType<typeof buildProposalButton> }> = [];

        if (allMatches.length > 0 && state.teamInfo) {
            const ownLogo = await getTeamLogo(teamId, state.teamInfo.logoUrl);
            for (const match of allMatches) {
                const opponentLogo = await getTeamLogo(match.opponentId, match.opponentLogoUrl);
                matchCards.push({
                    buffer: await renderMatchCard({
                        ownTag: state.teamInfo.teamTag,
                        ownLogo,
                        opponentName: match.opponentName,
                        opponentTag: match.opponentTag,
                        opponentLogo,
                        gameType: match.gameType,
                        scheduledDate: match.scheduledDate,
                    }),
                    button: buildMatchButton(teamId, match),
                });
            }
        }

        if (state.activeProposals.length > 0) {
            for (const proposal of state.activeProposals) {
                const opponentLogo = proposal.opponentLogoUrl
                    ? await getTeamLogo(proposal.opponentTag, proposal.opponentLogoUrl)
                    : null;
                proposalCards.push({
                    buffer: await renderProposalCard({
                        opponentName: proposal.opponentName,
                        opponentTag: proposal.opponentTag,
                        opponentLogo,
                        viableSlots: proposal.viableSlots,
                    }),
                    button: buildProposalButton(proposal),
                });
            }
        }

        // Detect if counts changed — if so, wipe everything and repost in order
        const countsChanged =
            matchCards.length !== state.matchMessageIds.length ||
            proposalCards.length !== state.proposalMessageIds.length;

        if (countsChanged) {
            // Delete all existing card messages
            await deleteMessages(botClient, state.channelId, state.matchMessageIds);
            await deleteMessages(botClient, state.channelId, state.proposalMessageIds);

            // Post fresh: matches first, then proposals (correct channel order)
            const newMatchIds = await syncCardMessages(
                botClient, state.channelId, [], matchCards,
            );
            const newProposalIds = await syncCardMessages(
                botClient, state.channelId, [], proposalCards,
            );

            state.matchMessageIds = newMatchIds;
            state.proposalMessageIds = newProposalIds;
            await firestoreDb.collection('botRegistrations').doc(teamId).update({
                matchMessageIds: newMatchIds,
                proposalMessageIds: newProposalIds,
            });
        } else {
            // Counts unchanged — edit in place (no reordering needed)
            const newMatchIds = await syncCardMessages(
                botClient, state.channelId, state.matchMessageIds, matchCards,
            );
            if (!arraysEqual(newMatchIds, state.matchMessageIds)) {
                state.matchMessageIds = newMatchIds;
                await firestoreDb.collection('botRegistrations').doc(teamId).update({
                    matchMessageIds: newMatchIds,
                });
            }

            const newProposalIds = await syncCardMessages(
                botClient, state.channelId, state.proposalMessageIds, proposalCards,
            );
            if (!arraysEqual(newProposalIds, state.proposalMessageIds)) {
                state.proposalMessageIds = newProposalIds;
                await firestoreDb.collection('botRegistrations').doc(teamId).update({
                    proposalMessageIds: newProposalIds,
                });
            }
        }
    } catch (err) {
        logger.error('Failed to sync card messages', {
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
        const logoUrl: string | null = data.activeLogo?.urls?.small ?? null;

        const roster: Record<string, RosterMember> = {};
        for (const userDoc of usersSnap.docs) {
            const userData = userDoc.data();
            const displayName = String(userData.displayName ?? 'Unknown');
            const initials = String(
                userData.initials ?? displayName.slice(0, 2).toUpperCase(),
            );
            roster[userDoc.id] = { displayName, initials };
        }

        return { teamId, teamTag, teamName, logoUrl, roster };
    } catch (err) {
        logger.error('Failed to fetch team info', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Poll scheduled matches and active proposals for a team.
 * Fetches enriched data including gameType, names, and opponent logo URLs.
 * Queries both current and next week.
 */
async function pollScheduledMatches(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb) return;

    try {
        // Scheduled matches for both weeks
        const [currentMatchesSnap, nextMatchesSnap] = await Promise.all([
            firestoreDb.collection('scheduledMatches')
                .where('blockedTeams', 'array-contains', teamId)
                .where('status', '==', 'upcoming')
                .where('weekId', '==', state.weekId)
                .get(),
            firestoreDb.collection('scheduledMatches')
                .where('blockedTeams', 'array-contains', teamId)
                .where('status', '==', 'upcoming')
                .where('weekId', '==', state.nextWeekId)
                .get(),
        ]);

        const prevMatchCount = state.scheduledMatches.length + state.nextWeekMatches.length;
        const prevProposalCount = state.activeProposals.length;

        // Collect opponent teamIds for logo fetching
        const opponentTeamIds = new Set<string>();

        // Build enriched match lists
        function buildMatchList(
            snap: FirebaseFirestore.QuerySnapshot,
            weekId: string,
        ): ScheduledMatchDisplay[] {
            const matches: ScheduledMatchDisplay[] = [];
            for (const doc of snap.docs) {
                const data = doc.data();
                const isTeamA = data.teamAId === teamId;
                const opponentId = isTeamA ? String(data.teamBId ?? '') : String(data.teamAId ?? '');
                if (opponentId) opponentTeamIds.add(opponentId);

                if (data.slotId) {
                    matches.push({
                        slotId: String(data.slotId),
                        opponentTag: isTeamA ? String(data.teamBTag ?? '?') : String(data.teamATag ?? '?'),
                        opponentId,
                        opponentName: isTeamA ? String(data.teamBName ?? '') : String(data.teamAName ?? ''),
                        gameType: (data.gameType as 'official' | 'practice') ?? 'practice',
                        opponentLogoUrl: null,
                        scheduledDate: formatScheduledDate(String(data.slotId), weekId),
                    });
                }
            }
            return matches;
        }

        const scheduledMatches = buildMatchList(currentMatchesSnap, state.weekId);
        const nextWeekMatches = buildMatchList(nextMatchesSnap, state.nextWeekId);

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

        const seenIds = new Set<string>();
        const activeProposals: ActiveProposalDisplay[] = [];

        for (const snap of [proposerSnap, opponentSnap]) {
            for (const doc of snap.docs) {
                if (seenIds.has(doc.id)) continue;
                seenIds.add(doc.id);

                const data = doc.data();
                const isProposer = data.proposerTeamId === teamId;
                const oppId = isProposer ? String(data.opponentTeamId ?? '') : String(data.proposerTeamId ?? '');
                if (oppId) opponentTeamIds.add(oppId);

                activeProposals.push({
                    proposalId: doc.id,
                    opponentTag: isProposer
                        ? String(data.opponentTeamTag ?? '?')
                        : String(data.proposerTeamTag ?? '?'),
                    opponentName: isProposer
                        ? String(data.opponentTeamName ?? '')
                        : String(data.proposerTeamName ?? ''),
                    viableSlots: Array.isArray(data.confirmedSlots) ? data.confirmedSlots.length : 0,
                    opponentLogoUrl: null,
                });
            }
        }

        // Batch-fetch opponent team docs for logo URLs
        if (opponentTeamIds.size > 0) {
            const teamDocs = await Promise.all(
                [...opponentTeamIds].map(id => firestoreDb!.collection('teams').doc(id).get()),
            );
            const logoUrls = new Map<string, string | null>();
            for (const doc of teamDocs) {
                if (doc.exists) {
                    logoUrls.set(doc.id, doc.data()!.activeLogo?.urls?.small ?? null);
                }
            }

            // Fill logo URLs on matches (both weeks)
            for (const m of [...scheduledMatches, ...nextWeekMatches]) {
                m.opponentLogoUrl = logoUrls.get(m.opponentId) ?? null;
            }

            // Fill logo URLs on proposals
            const tagToId = new Map<string, string>();
            for (const snap of [currentMatchesSnap, nextMatchesSnap]) {
                for (const doc of snap.docs) {
                    const d = doc.data();
                    if (d.teamAId !== teamId) tagToId.set(String(d.teamATag ?? ''), String(d.teamAId));
                    if (d.teamBId !== teamId) tagToId.set(String(d.teamBTag ?? ''), String(d.teamBId));
                }
            }
            for (const snap of [proposerSnap, opponentSnap]) {
                for (const doc of snap.docs) {
                    const d = doc.data();
                    const isProposer = d.proposerTeamId === teamId;
                    const oppId = isProposer ? String(d.opponentTeamId ?? '') : String(d.proposerTeamId ?? '');
                    const oppTag = isProposer ? String(d.opponentTeamTag ?? '') : String(d.proposerTeamTag ?? '');
                    if (oppId) tagToId.set(oppTag, oppId);
                }
            }
            for (const p of activeProposals) {
                const oppId = tagToId.get(p.opponentTag);
                if (oppId) p.opponentLogoUrl = logoUrls.get(oppId) ?? null;
            }
        }

        // Sort matches chronologically
        const dayOrder: Record<string, number> = { mon: 0, tue: 1, wed: 2, thu: 3, fri: 4, sat: 5, sun: 6 };
        const sortMatches = (list: ScheduledMatchDisplay[]) => {
            list.sort((a, b) => {
                const [dayA, timeA = ''] = a.slotId.split('_');
                const [dayB, timeB = ''] = b.slotId.split('_');
                const dayCmp = (dayOrder[dayA] ?? 9) - (dayOrder[dayB] ?? 9);
                return dayCmp !== 0 ? dayCmp : timeA.localeCompare(timeB);
            });
        };
        sortMatches(scheduledMatches);
        sortMatches(nextWeekMatches);

        state.scheduledMatches = scheduledMatches;
        state.nextWeekMatches = nextWeekMatches;
        state.activeProposals = activeProposals;

        // Trigger re-render if matches or proposals changed
        const newMatchCount = scheduledMatches.length + nextWeekMatches.length;
        if (newMatchCount !== prevMatchCount || activeProposals.length !== prevProposalCount) {
            scheduleRender(teamId);
        }
    } catch (err) {
        logger.warn('Failed to poll scheduled matches/proposals', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function arraysEqual(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Delete an array of Discord messages (best-effort, ignores failures). */
async function deleteMessages(client: Client, channelId: string, messageIds: string[]): Promise<void> {
    if (messageIds.length === 0) return;
    try {
        const fetched = await client.channels.fetch(channelId);
        if (!fetched || !fetched.isTextBased()) return;
        const channel = fetched as import('discord.js').TextChannel;
        for (const id of messageIds) {
            try {
                const msg = await channel.messages.fetch(id);
                await msg.delete();
            } catch { /* already gone */ }
        }
    } catch { /* channel gone */ }
}
