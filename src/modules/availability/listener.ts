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

import { type Client, type TextChannel, PermissionFlagsBits } from 'discord.js';
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
    // Proposals (real-time subscription)
    proposalUnsub: () => void;
    // Shared
    registrationUnsub: () => void;
    pollTimer: ReturnType<typeof setInterval> | null;
    debounceTimer: ReturnType<typeof setTimeout> | null;
    teamInfo: TeamInfo | null;
    activeProposals: ActiveProposalDisplay[];
    matchMessageIds: string[];
    proposalMessageIds: string[];
    // Event message — rolling "last N events" line at bottom of #schedule
    eventMessageId: string | null;
    recentEvents: string[];          // last 3 event lines (newest first)
    prevProposalIds: Set<string>;
    prevMatchKeys: Set<string>;      // "slotId:opponentId" composite keys
    isInitialRender: boolean;
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
        const eventMessageId = (data.eventMessageId as string | null) ?? null;

        if (!channelId) continue;

        try {
            await startTeamListener(teamId, channelId, messageId, nextWeekMessageId, matchMessageIds, proposalMessageIds, eventMessageId);
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

// ── Channel permission self-heal ─────────────────────────────────────────────

/**
 * Verify the bot can send messages in the schedule channel.
 * If the bot's user-level permission override is missing (e.g. manually removed),
 * re-add it. This handles the case where channel permissions were edited in Discord
 * and the bot lost its SendMessages override.
 */
async function ensureChannelPermissions(client: Client, channelId: string, teamId: string): Promise<void> {
    try {
        const channel = await client.channels.fetch(channelId);
        if (!channel || !channel.isTextBased()) return;
        const textChannel = channel as TextChannel;
        const me = textChannel.guild.members.me;
        if (!me) return;

        const perms = textChannel.permissionsFor(me);
        if (perms.has(PermissionFlagsBits.SendMessages) && perms.has(PermissionFlagsBits.AttachFiles)) {
            logger.debug('Channel permissions OK', { channelId, teamId });
            return;
        }

        // Bot can't send — try to add our own override
        logger.warn('Bot missing SendMessages on schedule channel, adding override', { channelId, teamId });
        await textChannel.permissionOverwrites.edit(me.id, {
            SendMessages: true,
            EmbedLinks: true,
            AttachFiles: true,
        });
        logger.info('Restored bot permission override on schedule channel', { channelId, teamId });
    } catch (err) {
        logger.warn('Could not verify/fix channel permissions', {
            channelId, teamId, error: err instanceof Error ? err.message : String(err),
        });
    }
}

// ── Per-team lifecycle ───────────────────────────────────────────────────────

export async function startTeamListener(
    teamId: string,
    channelId: string,
    storedMessageId: string | null,
    storedNextWeekMessageId: string | null = null,
    storedMatchMessageIds: string[] = [],
    storedProposalMessageIds: string[] = [],
    storedEventMessageId: string | null = null,
): Promise<void> {
    if (!firestoreDb || !botClient) return;

    // Teardown existing listener if any
    if (activeTeams.has(teamId)) {
        teardownTeam(teamId);
    }

    // Ensure bot has SendMessages permission on the channel
    await ensureChannelPermissions(botClient, channelId, teamId);

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
        // Proposals
        proposalUnsub: () => {},
        // Shared
        registrationUnsub: () => {},
        pollTimer: null,
        debounceTimer: null,
        teamInfo: null,
        activeProposals: [],
        matchMessageIds: storedMatchMessageIds,
        proposalMessageIds: storedProposalMessageIds,
        // Event message
        eventMessageId: storedEventMessageId,
        recentEvents: [],
        prevProposalIds: new Set(),
        prevMatchKeys: new Set(),
        isInitialRender: true,
    };

    activeTeams.set(teamId, state);

    // Fetch initial team info before first render
    state.teamInfo = await fetchTeamInfo(teamId);

    // Subscribe to availability changes for both weeks
    state.availabilityUnsub = subscribeAvailability(teamId, weekId, 'current');
    state.nextWeekUnsub = subscribeAvailability(teamId, nextWeekId, 'next');

    // Subscribe to proposals (real-time add/cancel detection)
    state.proposalUnsub = subscribeProposals(teamId);

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
    state.proposalUnsub();
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

// ── Proposal subscription ────────────────────────────────────────────────────

/**
 * Subscribe to active proposals for a team (both sides — proposer and opponent).
 * Fires immediately on load (initial state) and on any add/cancel.
 * When a proposal is cancelled on the website, the doc leaves the active query,
 * triggering a snapshot → refreshProposals → render → card deleted.
 */
function subscribeProposals(teamId: string): () => void {
    if (!firestoreDb) return () => {};

    const proposerDocs = new Map<string, FirebaseFirestore.DocumentData>();
    const opponentDocs = new Map<string, FirebaseFirestore.DocumentData>();
    let debounce: ReturnType<typeof setTimeout> | null = null;

    function scheduleRefresh() {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
            debounce = null;
            refreshProposals(teamId, proposerDocs, opponentDocs).catch(err => {
                logger.error('Failed to refresh proposals', {
                    teamId, error: err instanceof Error ? err.message : String(err),
                });
            });
        }, 1000);
    }

    const unsub1 = firestoreDb.collection('matchProposals')
        .where('proposerTeamId', '==', teamId)
        .where('status', '==', 'active')
        .onSnapshot(
            (snap) => {
                proposerDocs.clear();
                for (const doc of snap.docs) proposerDocs.set(doc.id, doc.data());
                scheduleRefresh();
            },
            (err) => logger.error('Proposal subscription error (proposer)', {
                teamId, error: err instanceof Error ? err.message : String(err),
            }),
        );

    const unsub2 = firestoreDb.collection('matchProposals')
        .where('opponentTeamId', '==', teamId)
        .where('status', '==', 'active')
        .onSnapshot(
            (snap) => {
                opponentDocs.clear();
                for (const doc of snap.docs) opponentDocs.set(doc.id, doc.data());
                scheduleRefresh();
            },
            (err) => logger.error('Proposal subscription error (opponent)', {
                teamId, error: err instanceof Error ? err.message : String(err),
            }),
        );

    return () => {
        if (debounce) clearTimeout(debounce);
        unsub1();
        unsub2();
    };
}

/**
 * Rebuild state.activeProposals from the current snapshot docs.
 * Fetches opponent logos + availability, computes viable slots.
 * Triggers a re-render if the proposal count changed.
 */
async function refreshProposals(
    teamId: string,
    proposerDocs: Map<string, FirebaseFirestore.DocumentData>,
    opponentDocs: Map<string, FirebaseFirestore.DocumentData>,
): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb) return;

    const prevCount = state.activeProposals.length;

    // Deduplicate both sides
    const seenIds = new Set<string>();
    const allDocs: Array<[string, FirebaseFirestore.DocumentData]> = [];
    for (const entry of [...proposerDocs.entries(), ...opponentDocs.entries()]) {
        if (seenIds.has(entry[0])) continue;
        seenIds.add(entry[0]);
        allDocs.push(entry);
    }

    if (allDocs.length === 0) {
        state.activeProposals = [];
        if (prevCount !== 0) scheduleRender(teamId);
        return;
    }

    // Collect unique opponent teamIds and (opponent, weekId) pairs for batch reads
    const opponentTeamIds = new Set<string>();
    const availDocIds = new Set<string>();
    for (const [, data] of allDocs) {
        const isProposer = data.proposerTeamId === teamId;
        const oppId = String(isProposer ? data.opponentTeamId : data.proposerTeamId);
        const weekId = String(data.weekId);
        opponentTeamIds.add(oppId);
        availDocIds.add(`${oppId}_${weekId}`);
    }

    // Batch fetch opponent team docs (logo URLs) + opponent availability docs
    const [teamDocs, availDocs] = await Promise.all([
        Promise.all([...opponentTeamIds].map(id => firestoreDb!.collection('teams').doc(id).get())),
        Promise.all([...availDocIds].map(id => firestoreDb!.collection('availability').doc(id).get())),
    ]);

    const opponentLogoMap = new Map<string, string | null>();
    for (const doc of teamDocs) {
        opponentLogoMap.set(doc.id, doc.exists ? (doc.data()!.activeLogo?.urls?.small ?? null) : null);
    }

    const opponentAvailMap = new Map<string, AvailabilityData | null>();
    for (const doc of availDocs) {
        opponentAvailMap.set(doc.id, doc.exists ? doc.data() as AvailabilityData : null);
    }

    // Build enriched proposal list
    const activeProposals: typeof state.activeProposals = [];
    for (const [id, data] of allDocs) {
        const isProposer = data.proposerTeamId === teamId;
        const oppId = String(isProposer ? data.opponentTeamId : data.proposerTeamId);
        const weekId = String(data.weekId);

        const teamAvail = weekId === state.weekId
            ? state.lastAvailability
            : (weekId === state.nextWeekId ? state.nextWeekAvailability : null);
        const oppAvail = opponentAvailMap.get(`${oppId}_${weekId}`) ?? null;

        const minFilter = data.minFilter as { yourTeam: number; opponent: number } | undefined;
        const ourMin = isProposer ? (minFilter?.yourTeam ?? 4) : (minFilter?.opponent ?? 4);
        const oppMin = isProposer ? (minFilter?.opponent ?? 4) : (minFilter?.yourTeam ?? 4);
        const ourStandin = Boolean(isProposer ? data.proposerStandin : data.opponentStandin);
        const oppStandin = Boolean(isProposer ? data.opponentStandin : data.proposerStandin);

        activeProposals.push({
            proposalId: id,
            opponentTag: String(isProposer ? (data.opponentTeamTag ?? '?') : (data.proposerTeamTag ?? '?')),
            opponentName: String(isProposer ? (data.opponentTeamName ?? '') : (data.proposerTeamName ?? '')),
            gameType: (data.gameType as 'official' | 'practice') ?? 'practice',
            viableSlots: computeViableSlots(teamAvail, oppAvail, ourMin, oppMin, ourStandin, oppStandin),
            opponentLogoUrl: opponentLogoMap.get(oppId) ?? null,
        });
    }

    state.activeProposals = activeProposals;

    if (activeProposals.length !== prevCount) {
        scheduleRender(teamId);
    }
}

/** Count slots where both teams meet the minimum player threshold. */
function computeViableSlots(
    teamAvail: AvailabilityData | null,
    oppAvail: AvailabilityData | null,
    ourMin: number,
    oppMin: number,
    ourStandin: boolean,
    oppStandin: boolean,
): number {
    const teamSlots = teamAvail?.slots ?? {};
    const oppSlots = oppAvail?.slots ?? {};
    const allSlotIds = new Set([...Object.keys(teamSlots), ...Object.keys(oppSlots)]);

    let viable = 0;
    for (const slotId of allSlotIds) {
        const ourPlayers = teamSlots[slotId] ?? [];
        const oppPlayers = oppSlots[slotId] ?? [];
        const effectiveOur = Math.min(4, ourPlayers.length + (ourStandin ? 1 : 0));
        const effectiveOpp = Math.min(4, oppPlayers.length + (oppStandin ? 1 : 0));
        if (effectiveOur >= ourMin && effectiveOpp >= oppMin) viable++;
    }
    return viable;
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
    const renderStart = Date.now();

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

    logger.debug('Grids rendered', { teamId, ms: Date.now() - renderStart });

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

    // If next week grid was reposted, current week grid + cards + event message are now above it — repost all
    if (nextWeekReposted) {
        await deleteMessages(botClient, state.channelId, [
            ...(state.messageId ? [state.messageId] : []),
            ...state.matchMessageIds,
            ...state.proposalMessageIds,
            ...(state.eventMessageId ? [state.eventMessageId] : []),
        ]);
        state.messageId = null;
        state.matchMessageIds = [];
        state.proposalMessageIds = [];
        state.eventMessageId = null;
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

    // If current week grid was reposted, cards + event message are now above it — delete them
    if (currentWeekReposted && !nextWeekReposted) {
        await deleteMessages(botClient, state.channelId, [
            ...state.matchMessageIds,
            ...state.proposalMessageIds,
            ...(state.eventMessageId ? [state.eventMessageId] : []),
        ]);
        state.matchMessageIds = [];
        state.proposalMessageIds = [];
        state.eventMessageId = null;
        await firestoreDb.collection('botRegistrations').doc(teamId).update({
            matchMessageIds: [],
            proposalMessageIds: [],
            eventMessageId: null,
        });
    }

    // Persist message IDs if either grid was reposted
    if (nextWeekReposted || currentWeekReposted) {
        await firestoreDb.collection('botRegistrations').doc(teamId).update({
            nextWeekMessageId: state.nextWeekMessageId,
            scheduleMessageId: state.messageId,
            matchMessageIds: state.matchMessageIds,
            proposalMessageIds: state.proposalMessageIds,
            eventMessageId: state.eventMessageId,
        });
    }

    // ── Render match + proposal card messages ──
    // Combine both weeks' matches, sorted chronologically.
    try {
        const allMatches = [...state.scheduledMatches, ...state.nextWeekMatches];
        const matchCards: Array<{ buffer: Buffer; button: ReturnType<typeof buildMatchButton> }> = [];
        const proposalCards: Array<{ buffer: Buffer; button: ReturnType<typeof buildProposalButton> }> = [];

        // Fetch own logo once — used for both match cards and proposal cards
        const ownLogo = state.teamInfo
            ? await getTeamLogo(teamId, state.teamInfo.logoUrl)
            : null;

        if (allMatches.length > 0 && state.teamInfo) {
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

        if (state.activeProposals.length > 0 && state.teamInfo) {
            for (const proposal of state.activeProposals) {
                const opponentLogo = proposal.opponentLogoUrl
                    ? await getTeamLogo(proposal.opponentTag, proposal.opponentLogoUrl)
                    : null;
                proposalCards.push({
                    buffer: await renderProposalCard({
                        ownTag: state.teamInfo.teamTag,
                        ownLogo,
                        opponentName: proposal.opponentName,
                        opponentTag: proposal.opponentTag,
                        opponentLogo,
                        gameType: proposal.gameType,
                        viableSlots: proposal.viableSlots,
                    }),
                    button: buildProposalButton(proposal),
                });
            }
        }

        // If match count increased, new match messages would appear after existing
        // proposal messages, breaking the intended order (matches above proposals).
        // Wipe all cards and repost in correct order only in that case.
        const matchCountIncreased = matchCards.length > state.matchMessageIds.length;

        if (matchCountIncreased) {
            // Delete all existing card messages
            await deleteMessages(botClient, state.channelId, state.matchMessageIds);
            await deleteMessages(botClient, state.channelId, state.proposalMessageIds);

            // Post fresh: matches first, then proposals (correct channel order)
            const newMatchIds = await syncCardMessages(
                botClient, state.channelId, [], matchCards, state.teamId,
            );
            const newProposalIds = await syncCardMessages(
                botClient, state.channelId, [], proposalCards, state.teamId,
            );

            state.matchMessageIds = newMatchIds;
            state.proposalMessageIds = newProposalIds;
            await firestoreDb.collection('botRegistrations').doc(teamId).update({
                matchMessageIds: newMatchIds,
                proposalMessageIds: newProposalIds,
            });
        } else {
            // Edit in place, delete excess — syncCardMessages handles all of this
            const newMatchIds = await syncCardMessages(
                botClient, state.channelId, state.matchMessageIds, matchCards, state.teamId,
            );
            if (!arraysEqual(newMatchIds, state.matchMessageIds)) {
                state.matchMessageIds = newMatchIds;
                await firestoreDb.collection('botRegistrations').doc(teamId).update({
                    matchMessageIds: newMatchIds,
                });
            }

            const newProposalIds = await syncCardMessages(
                botClient, state.channelId, state.proposalMessageIds, proposalCards, state.teamId,
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

    // ── Event message — rolling "last 3 events" at bottom of #schedule ──
    // Delete + repost (not edit) so Discord fires an unread notification.
    const MAX_RECENT_EVENTS = 3;
    try {
        const currentProposalIds = new Set(state.activeProposals.map(p => p.proposalId));
        const allMatches = [...state.scheduledMatches, ...state.nextWeekMatches];
        const currentMatchKeys = new Set(allMatches.map(m => `${m.slotId}:${m.opponentId}`));

        if (state.isInitialRender) {
            // First render — populate prev state without posting event message
            state.prevProposalIds = currentProposalIds;
            state.prevMatchKeys = currentMatchKeys;
            state.isInitialRender = false;
        } else {
            const newProposals = [...currentProposalIds].filter(id => !state.prevProposalIds.has(id));
            const newMatches = [...currentMatchKeys].filter(k => !state.prevMatchKeys.has(k));

            // Collect new event lines (matches first, then proposals)
            const newEventLines: string[] = [];

            for (const matchKey of newMatches) {
                const match = allMatches.find(m => `${m.slotId}:${m.opponentId}` === matchKey);
                if (match && state.teamInfo) {
                    newEventLines.push(`\u{1F4C5} Match scheduled: ${state.teamInfo.teamTag} vs ${match.opponentTag} ${match.opponentName} \u2014 ${match.scheduledDate}`);
                }
            }
            for (const proposalId of newProposals) {
                const proposal = state.activeProposals.find(p => p.proposalId === proposalId);
                if (proposal) {
                    const typeLabel = proposal.gameType === 'official' ? 'Official' : 'Practice';
                    newEventLines.push(`\u{1F4E9} New challenge from ${proposal.opponentTag} ${proposal.opponentName} \u2014 ${typeLabel}`);
                }
            }

            if (newEventLines.length > 0) {
                // Prepend new events (newest first), keep max 3 total
                state.recentEvents = [...newEventLines, ...state.recentEvents].slice(0, MAX_RECENT_EVENTS);

                // Delete old event message
                if (state.eventMessageId) {
                    await deleteMessages(botClient, state.channelId, [state.eventMessageId]);
                    state.eventMessageId = null;
                }
                // Post new event message (plain text, triggers Discord unread)
                const messageText = state.recentEvents.join('\n');
                try {
                    const channel = await botClient.channels.fetch(state.channelId);
                    if (channel && channel.isTextBased()) {
                        const msg = await (channel as TextChannel).send(messageText);
                        state.eventMessageId = msg.id;
                        logger.info('Posted event message', { teamId, events: state.recentEvents.length });
                    }
                } catch (err) {
                    logger.warn('Failed to post event message', {
                        teamId, error: err instanceof Error ? err.message : String(err),
                    });
                }
                await firestoreDb.collection('botRegistrations').doc(teamId).update({
                    eventMessageId: state.eventMessageId,
                });
            }

            state.prevProposalIds = currentProposalIds;
            state.prevMatchKeys = currentMatchKeys;
        }
    } catch (err) {
        logger.warn('Failed to handle event message', {
            teamId, error: err instanceof Error ? err.message : String(err),
        });
    }

    logger.info('Render complete', {
        teamId,
        ms: Date.now() - renderStart,
        grids: { nextWeek: !!state.nextWeekMessageId, currentWeek: !!state.messageId },
        cards: { matches: state.matchMessageIds.length, proposals: state.proposalMessageIds.length },
        event: state.eventMessageId ? 'posted' : 'none',
        initial: state.isInitialRender,
    });
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
 * Poll scheduled matches for a team (current week + next week).
 * Proposals are handled separately via subscribeProposals (real-time).
 */
async function pollScheduledMatches(teamId: string): Promise<void> {
    const state = activeTeams.get(teamId);
    if (!state || !firestoreDb) return;

    // If week has rolled since last render, trigger a render which will handle resubscription.
    // This is the only active rollover detector — Firestore snapshots alone won't fire if
    // nobody updates availability right after midnight.
    if (getCurrentWeekId() !== state.weekId) {
        scheduleRender(teamId);
        return;
    }

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
        const opponentTeamIds = new Set<string>();

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

        // Batch-fetch opponent logos
        if (opponentTeamIds.size > 0) {
            const teamDocs = await Promise.all(
                [...opponentTeamIds].map(id => firestoreDb!.collection('teams').doc(id).get()),
            );
            const logoUrls = new Map<string, string | null>();
            for (const doc of teamDocs) {
                if (doc.exists) logoUrls.set(doc.id, doc.data()!.activeLogo?.urls?.small ?? null);
            }
            for (const m of [...scheduledMatches, ...nextWeekMatches]) {
                m.opponentLogoUrl = logoUrls.get(m.opponentId) ?? null;
            }
        }

        // Sort chronologically
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

        const newMatchCount = scheduledMatches.length + nextWeekMatches.length;
        if (newMatchCount !== prevMatchCount) {
            scheduleRender(teamId);
        }

        // Proposals keepalive — Firestore onSnapshot listeners can silently die after
        // prolonged idle. Do a one-shot query every poll cycle to catch missed updates.
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
        const polledIds = new Set<string>();
        for (const doc of [...proposerSnap.docs, ...opponentSnap.docs]) polledIds.add(doc.id);
        const subscribedIds = new Set(state.activeProposals.map(p => p.proposalId));
        // Check if the subscription state is stale
        const hasMissing = [...polledIds].some(id => !subscribedIds.has(id));
        const hasExtra = [...subscribedIds].some(id => !polledIds.has(id));
        if (hasMissing || hasExtra) {
            logger.warn('Proposal subscription appears stale, forcing refresh', {
                teamId, polled: polledIds.size, subscribed: subscribedIds.size,
            });
            // Restart the proposal subscription
            state.proposalUnsub();
            state.proposalUnsub = subscribeProposals(teamId);
        }
    } catch (err) {
        logger.warn('Failed to poll scheduled matches', {
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
