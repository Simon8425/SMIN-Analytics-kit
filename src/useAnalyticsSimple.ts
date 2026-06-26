/**
 * useAnalyticsSimple.ts - Core analytics with cross-tab deduplication
 *
 * Features:
 * - Session singleton: All tabs share one session via window global
 * - Cross-tab dedup: Only leader tab sends heartbeats (BroadcastChannel)
 * - Lazy loading: Detection utilities load after initial tracking
 * - Accurate heartbeat: Adaptive 3s→6s intervals with timeout/circuit breaker
 */

import { useEffect, useRef } from 'react';
import { SupabaseClient } from '@supabase/supabase-js';

// ==================== LAZY IMPORT ====================

let detectionLoaded = false;
let detectionPromise: Promise<void> | null = null;
let detectDevice: (ua: string) => string = () => 'desktop';
let detectOS: (ua: string) => string = () => 'Other';
let parseReferrerSource: (ref: string | null) => { source: string; category: string } = () => ({ source: 'Direct', category: 'Direct' });
let detectBrowser: (ua: string) => string = () => 'Other';

const loadDetectionUtils = (): Promise<void> => {
    if (detectionLoaded) return Promise.resolve();
    if (!detectionPromise) {
        detectionPromise = import('./useAnalyticsSecondary')
            .then((mod) => {
                detectDevice = mod.detectDevice;
                detectOS = mod.detectOS;
                detectBrowser = mod.detectBrowser;
                parseReferrerSource = mod.parseReferrerSource;
                detectionLoaded = true;
            })
            .catch((err) => {
                debugWarn('Detection utils failed', err);
                detectionLoaded = true;
            })
            .finally(() => { detectionPromise = null; });
    }
    return detectionPromise;
};

const ensureDetectionReady = () => detectionLoaded ? Promise.resolve() : loadDetectionUtils();

// ==================== TYPES ====================

type VisitPayload = {
    p_session_id: string;
    p_path: string;
    p_user_agent: string;
    p_referrer: string | null;
    p_referrer_source: string | null;
    p_referrer_category: string | null;
    p_browser: string;
    p_device: string;
    p_os: string;
    p_event_id: string;
};

type HeartbeatPayload = {
    p_session_id: string;
    p_path: string;
    p_scroll_percentage: number;
    p_added_seconds: number;
    p_event_id: string;
};

type QueuedEvent =
    | { kind: 'visit'; payload: VisitPayload; createdAt: number }
    | { kind: 'heartbeat'; payload: HeartbeatPayload; createdAt: number };

type RpcResult<T> = { data: T | null; error: unknown };
type RpcFn<T> = () => PromiseLike<RpcResult<T>>;
type SafeRpc = <T>(fn: RpcFn<T>) => Promise<{ success: boolean }>;

interface AnalyticsConfig {
    supabase: SupabaseClient;
    debug?: boolean;
    excludePaths?: string[];
    restUrl?: string;
    anonKey?: string;
}

// ==================== SESSION SINGLETON ====================

type GlobalState = {
    sessionId: string;
    tabId: number; // Timestamp for leader election
    isLeader: boolean;
    broadcastChannel: BroadcastChannel | null;
    lastLeaderPing: number;
    initialized: boolean;
    leaderIntervals: Array<ReturnType<typeof setInterval>>;
    leaderTimeouts: Array<ReturnType<typeof setTimeout>>;
    leaderUsers: number;
    debugEnabled: boolean;
    debugUsers: number;
    devLastVisitPath?: string;
    devLastVisitAt?: number;
    historyPatched: boolean;
    historyUsers: number;
    origPush: History['pushState'] | null;
    origReplace: History['replaceState'] | null;
    navHandlers: Set<() => void>;
    popstateListener: ((ev: PopStateEvent) => void) | null;
};

const GLOBAL_KEY = '__analytics_v2__';
const BC_CHANNEL = 'analytics_hb_v1';

const getGlobalState = (): GlobalState => {
    const w = window as Window & { [GLOBAL_KEY]?: GlobalState };
    if (!w[GLOBAL_KEY]) {
        w[GLOBAL_KEY] = {
            sessionId: '',
            tabId: (Date.now() * 1000) + Math.floor(Math.random() * 1000), // Timestamp + entropy for deterministic leader election
            isLeader: true,
            broadcastChannel: null,
            lastLeaderPing: Date.now(),
            initialized: false,
            leaderIntervals: [],
            leaderTimeouts: [],
            leaderUsers: 0,
            debugEnabled: false,
            debugUsers: 0,
            historyPatched: false,
            historyUsers: 0,
            origPush: null,
            origReplace: null,
            navHandlers: new Set<() => void>(),
            popstateListener: null,
        };
    }
    return w[GLOBAL_KEY];
};

const debugWarn = (...args: unknown[]) => {
    const globalState = getGlobalState();
    if (globalState.debugEnabled) {
        console.warn('[Analytics]', ...args);
    }
};

// ==================== CONSTANTS ====================

const QUEUE_KEY = 'analytics_queue_v1';
const QUEUE_LOCK_KEY = 'analytics_queue_lock_v1';
const SESSION_KEY = 'analytics_session_id';
const RPC_TIMEOUT_MS = 8000; // RPC timeout guard
const CIRCUIT_BREAKER_THRESHOLD = 3;
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;
const BASE_HEARTBEAT_MS = 3000;
const SAMPLING_STEPS = [{ afterSeconds: 600, intervalMs: 6000 }]; // 10 min -> 6s heartbeat
const MAX_QUEUE_SIZE = 50; // cap localStorage usage
const QUEUE_TTL_MS = 24 * 60 * 60 * 1000; // 24h TTL
const ACTIVITY_TIMEOUT_MS = 60000; // 60s - reduce inflated time-on-page
const LEADER_PING_MS = 1000;
const LEADER_CHECK_MS = 1000;
const LEADER_TIMEOUT_MS = 2000;
const LEADER_SELF_PROMOTE_MS = LEADER_PING_MS * 2;
const MAX_HEARTBEAT_SECONDS = 30; // server-side cap per heartbeat
const MAX_UA_CHARS = 512; // avoid oversized payloads
const QUEUE_LOCK_TTL_MS = 4000;

type CircuitState = { failCount: number; openUntil: number };
const circuitStates = new Map<string, CircuitState>();
const getCircuitState = (sessionId: string): CircuitState => {
    let state = circuitStates.get(sessionId);
    if (!state) {
        state = { failCount: 0, openUntil: 0 };
        circuitStates.set(sessionId, state);
    }
    return state;
};

// ==================== HELPERS ====================

const withTimeout = <T>(p: PromiseLike<T>, ms: number): Promise<T> =>
    new Promise((resolve, reject) => {
        let done = false;
        const t = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
        Promise.resolve(p).then(v => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
            .catch(e => { if (!done) { done = true; clearTimeout(t); reject(e); } });
    });

const computeInterval = (startTime: number): number => {
    const secs = (Date.now() - startTime) / 1000;
    for (const s of SAMPLING_STEPS) if (secs > s.afterSeconds) return s.intervalMs;
    return BASE_HEARTBEAT_MS;
};

const uuidv4 = (): string => {
    const cryptoObj = globalThis.crypto;
    if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
    if (cryptoObj?.getRandomValues) {
        const bytes = new Uint8Array(16);
        cryptoObj.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
};

const getStoredSessionId = (): string | null => {
    try {
        const existing = sessionStorage.getItem(SESSION_KEY);
        if (existing) return existing;
    } catch (err) { debugWarn('SessionStorage read failed', err); }
    try {
        const existing = localStorage.getItem(SESSION_KEY);
        if (existing) return existing;
    } catch (err) { debugWarn('LocalStorage read failed', err); }
    return null;
};

const setStoredSessionId = (id: string): void => {
    try { sessionStorage.setItem(SESSION_KEY, id); return; } catch (err) { debugWarn('SessionStorage write failed', err); }
    try { localStorage.setItem(SESSION_KEY, id); } catch (err) { debugWarn('LocalStorage write failed', err); }
};

const getSessionId = (): string => {
    const globalState = getGlobalState();
    if (globalState.sessionId) return globalState.sessionId;
    try {
        const existing = getStoredSessionId();
        if (existing) { globalState.sessionId = existing; return existing; }
        const newId = uuidv4();
        setStoredSessionId(newId);
        globalState.sessionId = newId;
        return newId;
    } catch (err) {
        debugWarn('Session ID init failed', err);
        globalState.sessionId = 'mem_' + uuidv4();
        return globalState.sessionId;
    }
};

const getScrollPercent = (): number => {
    const h = document.documentElement.scrollHeight - window.innerHeight;
    return h <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((window.scrollY / h) * 100)));
};

const getPath = (): string => {
    const url = new URL(window.location.href);
    const hash = window.location.hash || '';
    if (hash.startsWith('#/') || hash.startsWith('#!')) {
        const hashPath = hash.startsWith('#!') ? hash.slice(2) : hash.slice(1);
        // Strip search from hash path if present
        return hashPath.split('?')[0];
    }
    return url.pathname; // Stripped search params for aggregation
};

const SENSITIVE_REFERRER_PARAMS = new Set([
    'token', 'access_token', 'id_token', 'refresh_token', 'password', 'secret',
    'code', 'state', 'session_state', 'oobcode', 'otp', 'reset_code',
    'ticket', 'auth', 'jwt', 'signature',
]);

const sanitizeReferrer = (referrer: string | null): string | null => {
    if (!referrer) return null;
    try {
        const url = new URL(referrer);
        SENSITIVE_REFERRER_PARAMS.forEach((param) => url.searchParams.delete(param));
        url.hash = '';
        return url.toString();
    } catch {
        return referrer.split('#')[0];
    }
};

const isPathExcluded = (path: string, excludePaths: string[]): boolean =>
    excludePaths.some(ex => path.startsWith(ex));

const withQueueLock = async <T>(fn: () => Promise<T> | T): Promise<T | null> => {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
        try {
            return await (navigator as Navigator & { locks: { request: Function } }).locks.request(
                'analytics-queue',
                { mode: 'exclusive', ifAvailable: true },
                async (lock: unknown) => {
                    if (!lock) return null;
                    return await fn();
                }
            );
        } catch (err) {
            debugWarn('Queue lock failed (navigator.locks)', err);
        }
    }

    const token = uuidv4();
    const now = Date.now();
    const lockPayload = { token, expires: now + QUEUE_LOCK_TTL_MS };
    try {
        const raw = localStorage.getItem(QUEUE_LOCK_KEY);
        if (raw) {
            const parsed = JSON.parse(raw) as { token?: string; expires?: number };
            if (parsed.expires && parsed.expires > now) return null;
        }
        localStorage.setItem(QUEUE_LOCK_KEY, JSON.stringify(lockPayload));
        const confirm = localStorage.getItem(QUEUE_LOCK_KEY);
        if (!confirm) return null;
        const confirmed = JSON.parse(confirm) as { token?: string };
        if (confirmed.token !== token) return null;
        return await fn();
    } catch (err) {
        debugWarn('Queue lock failed (localStorage)', err);
        return null;
    } finally {
        try {
            const current = localStorage.getItem(QUEUE_LOCK_KEY);
            if (!current) return;
            const parsed = JSON.parse(current) as { token?: string };
            if (parsed.token === token) localStorage.removeItem(QUEUE_LOCK_KEY);
        } catch (err) {
            debugWarn('Queue lock release failed', err);
        }
    }
};

// ==================== CROSS-TAB LEADER ELECTION ====================

const startLeaderTimers = (log: (...args: unknown[]) => void) => {
    const globalState = getGlobalState();
    if (globalState.leaderIntervals.length || globalState.leaderTimeouts.length) return;

    const selfPromoteTimeout = setTimeout(() => {
        if (!globalState.isLeader && Date.now() - globalState.lastLeaderPing >= LEADER_SELF_PROMOTE_MS) {
            globalState.isLeader = true;
            globalState.broadcastChannel?.postMessage({ type: 'leader', tabId: globalState.tabId });
            log('Leader election won (self-promote)');
        }
    }, LEADER_SELF_PROMOTE_MS);

    const reElectInterval = setInterval(() => {
        if (!globalState.isLeader && Date.now() - globalState.lastLeaderPing >= LEADER_TIMEOUT_MS) {
            globalState.isLeader = true;
            globalState.broadcastChannel?.postMessage({ type: 'leader', tabId: globalState.tabId });
            log('Leader election won (timeout)');
        }
    }, LEADER_CHECK_MS);

    const leaderPingInterval = setInterval(() => {
        if (globalState.isLeader) globalState.broadcastChannel?.postMessage({ type: 'ping', tabId: globalState.tabId });
    }, LEADER_PING_MS);

    globalState.leaderIntervals.push(reElectInterval, leaderPingInterval);
    globalState.leaderTimeouts.push(selfPromoteTimeout);
};

const initLeaderElection = (log: (...args: unknown[]) => void) => {
    const globalState = getGlobalState();
    globalState.leaderUsers += 1;
    if (globalState.leaderIntervals.length || globalState.leaderTimeouts.length) return; // already running

    if (typeof BroadcastChannel === 'undefined') {
        globalState.isLeader = true; // Fallback: all tabs are leaders (Safari <15.4)
        log('BroadcastChannel unsupported, single-tab mode');
        return;
    }

    try {
        if (!globalState.broadcastChannel) {
            globalState.broadcastChannel = new BroadcastChannel(BC_CHANNEL);
        }
        globalState.isLeader = false;
        globalState.lastLeaderPing = Date.now();

        globalState.broadcastChannel.onmessage = (ev) => {
            const m = ev.data;
            if (!m?.type || m.tabId === globalState.tabId) return;
            if (m.type === 'leader' && m.tabId < globalState.tabId) {
                globalState.isLeader = false; // Lower timestamp (older tab) wins
            }
            globalState.lastLeaderPing = Date.now();
        };

        // Announce presence
        globalState.broadcastChannel.postMessage({ type: 'leader', tabId: globalState.tabId });

        startLeaderTimers(log);
        log('Cross-tab dedup initialized, tabId:', globalState.tabId);
    } catch (e) {
        globalState.isLeader = true;
        log('BroadcastChannel failed, single-tab mode:', e);
    }
};

const teardownLeaderElection = (log: (...args: unknown[]) => void = () => { }) => {
    const globalState = getGlobalState();
    globalState.leaderUsers = Math.max(0, globalState.leaderUsers - 1);
    globalState.leaderIntervals.forEach(clearInterval);
    globalState.leaderIntervals = [];
    globalState.leaderTimeouts.forEach(clearTimeout);
    globalState.leaderTimeouts = [];
    if (globalState.leaderUsers === 0) {
        try { globalState.broadcastChannel?.close(); } catch (err) { debugWarn('BroadcastChannel close failed', err); }
        globalState.broadcastChannel = null;
        globalState.isLeader = true;
        globalState.lastLeaderPing = Date.now();
    } else if (globalState.broadcastChannel) {
        startLeaderTimers(log);
    }
};

const isLeader = (): boolean => getGlobalState().isLeader;

// ==================== HISTORY PATCH (DEDUP) ====================

const notifyNavigationHandlers = () => {
    const globalState = getGlobalState();
    globalState.navHandlers.forEach(fn => {
        try { fn(); } catch (err) { debugWarn('Navigation handler failed', err); }
    });
};

const registerNavigationHandler = (fn: () => void) => {
    getGlobalState().navHandlers.add(fn);
};

const unregisterNavigationHandler = (fn: () => void) => {
    getGlobalState().navHandlers.delete(fn);
};

const ensureHistoryPatched = (log: (...args: unknown[]) => void) => {
    const globalState = getGlobalState();
    globalState.historyUsers += 1;
    if (globalState.historyPatched) return;

    globalState.historyPatched = true;
    globalState.origPush = history.pushState.bind(history);
    globalState.origReplace = history.replaceState.bind(history);

    const notify = () => notifyNavigationHandlers();
    history.pushState = (...a: Parameters<History['pushState']>) => {
        const res = globalState.origPush ? globalState.origPush(...a) : undefined;
        notify();
        return res;
    };
    history.replaceState = (...a: Parameters<History['replaceState']>) => {
        const res = globalState.origReplace ? globalState.origReplace(...a) : undefined;
        notify();
        return res;
    };

    const popListener = () => notify();
    window.addEventListener('popstate', popListener);
    globalState.popstateListener = popListener;

    log('History patched for navigation tracking');
};

const teardownHistoryPatch = () => {
    const globalState = getGlobalState();
    globalState.historyUsers = Math.max(0, globalState.historyUsers - 1);
    if (!globalState.historyPatched || globalState.historyUsers > 0) return;

    if (globalState.origPush) history.pushState = globalState.origPush;
    if (globalState.origReplace) history.replaceState = globalState.origReplace;
    if (globalState.popstateListener) window.removeEventListener('popstate', globalState.popstateListener);

    globalState.historyPatched = false;
    globalState.origPush = null;
    globalState.origReplace = null;
    globalState.popstateListener = null;
};

// ==================== QUEUE MANAGEMENT ====================

const loadQueue = (): QueuedEvent[] => {
    try {
        const raw = localStorage.getItem(QUEUE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const now = Date.now();
        return parsed.filter(e => now - e.createdAt < QUEUE_TTL_MS);
    } catch (err) {
        debugWarn('Failed to load queue', err);
        return [];
    }
};

const saveQueue = (queue: QueuedEvent[]): void => {
    try {
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue.slice(-MAX_QUEUE_SIZE)));
    } catch (err) {
        debugWarn('Failed to save queue', err);
    }
};

const addToQueue = async (event: QueuedEvent): Promise<void> => {
    await withQueueLock(() => {
        const queue = loadQueue();
        if (queue.some(e => e.payload.p_event_id === event.payload.p_event_id)) return;
        queue.push(event);
        saveQueue(queue);
    });
};

const flushQueue = async (
    supabase: SupabaseClient,
    isFlushingRef: React.MutableRefObject<boolean>,
    safeRpc: SafeRpc
): Promise<void> => {
    // Guard against reentry; single-threaded JS makes this effectively atomic.
    if (isFlushingRef.current) return;
    isFlushingRef.current = true;
    try {
        const queue = await withQueueLock(() => loadQueue());
        if (!queue || !queue.length) return;
        const sentIds = new Set<string>();
        for (const e of queue) {
            const { success } = await safeRpc(() =>
                e.kind === 'visit' ? supabase.rpc('track_visit', e.payload) : supabase.rpc('track_heartbeat', e.payload)
            );
            if (success) sentIds.add(e.payload.p_event_id);
        }
        await withQueueLock(() => {
            saveQueue(loadQueue().filter(e => !sentIds.has(e.payload.p_event_id)));
        });
    } finally { isFlushingRef.current = false; }
};

// ==================== MAIN HOOK ====================

export function useAnalytics({
    supabase,
    debug = false,
    excludePaths = ['/admin'],
    restUrl,
    anonKey,
}: AnalyticsConfig) {
    const currentPathRef = useRef('');
    const lastHbTimeRef = useRef(Date.now());
    const fractionalSecondsRef = useRef(0);
    const sessionStartRef = useRef(Date.now());
    const maxScrollRef = useRef(0);
    const hbTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isFlushingRef = useRef(false);
    const navInProgressRef = useRef(false);
    const pendingNavPathRef = useRef<string | null>(null);
    const hasActivityRef = useRef(true);
    const lastActivityRef = useRef(Date.now());
    const excludePathsSigRef = useRef('');
    const excludePathsRef = useRef(excludePaths);

    const log = (...args: unknown[]) => { if (debug) console.log('[Analytics]', ...args); };

    const excludePathsSignature = JSON.stringify(excludePaths);
    if (excludePathsSigRef.current !== excludePathsSignature) {
        excludePathsSigRef.current = excludePathsSignature;
        excludePathsRef.current = excludePaths;
    }
    const stableExcludePaths = excludePathsRef.current;

    const safeRpc: SafeRpc = async (fn) => {
        const sessionId = getSessionId();
        const circuitState = getCircuitState(sessionId);
        if (Date.now() < circuitState.openUntil) return { success: false };
        try {
            const res = await withTimeout(fn(), RPC_TIMEOUT_MS);
            if (res?.error) throw res.error;
            circuitState.failCount = 0;
            return { success: true };
        } catch (err) {
            debugWarn('RPC failed', err);
            if (++circuitState.failCount >= CIRCUIT_BREAKER_THRESHOLD) {
                circuitState.openUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
            }
            return { success: false };
        }
    };

    const consumeElapsedSeconds = (now: number): number => {
        const elapsedMs = now - lastHbTimeRef.current;
        const totalSeconds = (elapsedMs / 1000) + fractionalSecondsRef.current;
        const wholeSeconds = Math.min(MAX_HEARTBEAT_SECONDS, Math.floor(totalSeconds));
        fractionalSecondsRef.current = totalSeconds - wholeSeconds;
        return Math.max(0, wholeSeconds);
    };

    const trackVisit = async (path: string) => {
        if (isPathExcluded(path, stableExcludePaths)) return;
        await ensureDetectionReady();
        const sessionId = getSessionId();
        const referrer = sanitizeReferrer(document.referrer || null);
        const globalState = getGlobalState();
        if (import.meta.env?.DEV) {
            const now = Date.now();
            const lastPath = globalState.devLastVisitPath || '';
            const lastAt = globalState.devLastVisitAt || 0;
            if (lastPath === path && now - lastAt < 1000) return;
            globalState.devLastVisitPath = path;
            globalState.devLastVisitAt = now;
        }
        const refInfo = parseReferrerSource(referrer);
        const payload: VisitPayload = {
            p_session_id: sessionId,
            p_path: path,
            p_user_agent: navigator.userAgent.slice(0, MAX_UA_CHARS),
            p_referrer: referrer,
            p_referrer_source: refInfo.source,
            p_referrer_category: refInfo.category,
            p_browser: detectBrowser(navigator.userAgent),
            p_device: detectDevice(navigator.userAgent),
            p_os: detectOS(navigator.userAgent),
            p_event_id: uuidv4(),
        };
        if (!navigator.onLine) { void addToQueue({ kind: 'visit', payload, createdAt: Date.now() }); return; }
        const { success } = await safeRpc(() => supabase.rpc('track_visit', payload));
        if (success) {
            currentPathRef.current = path;
            maxScrollRef.current = 0;
            lastHbTimeRef.current = Date.now();
            log('Visit:', path);
        } else {
            void addToQueue({ kind: 'visit', payload, createdAt: Date.now() });
        }
    };

    const sendHeartbeat = async () => {
        if (!currentPathRef.current || document.visibilityState === 'hidden') return;
        if (!isLeader()) { log('Not leader, skip heartbeat'); return; } // Cross-tab dedup

        const sinceActivity = Date.now() - lastActivityRef.current;
        if (!hasActivityRef.current && sinceActivity >= ACTIVITY_TIMEOUT_MS) return;

        const now = Date.now();
        const secs = consumeElapsedSeconds(now);
        if (secs === 0) return;

        const sessionId = getSessionId();
        const payload: HeartbeatPayload = {
            p_session_id: sessionId,
            p_path: currentPathRef.current,
            p_scroll_percentage: Math.max(maxScrollRef.current, getScrollPercent()),
            p_added_seconds: secs,
            p_event_id: uuidv4(),
        };

        if (!navigator.onLine) {
            void addToQueue({ kind: 'heartbeat', payload, createdAt: Date.now() });
            lastHbTimeRef.current = now;
            hasActivityRef.current = false;
            return;
        }

        const { success } = await safeRpc(() => supabase.rpc('track_heartbeat', payload));
        if (!success) void addToQueue({ kind: 'heartbeat', payload, createdAt: Date.now() });
        lastHbTimeRef.current = now;
        hasActivityRef.current = false;
        maxScrollRef.current = 0;
        log('Heartbeat:', secs + 's', isLeader() ? '(leader)' : '');
    };

    const sendFinalHeartbeat = async (opts: { fireAndForget?: boolean } = {}) => {
        if (!currentPathRef.current) return;
        const now = Date.now();
        const secs = consumeElapsedSeconds(now);
        if (secs === 0) return;

        const sessionId = getSessionId();
        const payload: HeartbeatPayload = {
            p_session_id: sessionId,
            p_path: currentPathRef.current,
            p_scroll_percentage: Math.max(maxScrollRef.current, getScrollPercent()),
            p_added_seconds: secs,
            p_event_id: uuidv4(),
        };

        const recordMeta = () => {
            lastHbTimeRef.current = now;
            maxScrollRef.current = 0;
            hasActivityRef.current = false;
        };

        if (!opts.fireAndForget) {
            const { success } = await safeRpc(() => supabase.rpc('track_heartbeat', payload));
            recordMeta();
            if (success) return;
        } else {
            recordMeta();
        }

        if (restUrl && anonKey && 'keepalive' in new Request('')) {
            try {
                await fetch(`${restUrl}/rest/v1/rpc/track_heartbeat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', apikey: anonKey, Authorization: `Bearer ${anonKey}` },
                    body: JSON.stringify(payload),
                    keepalive: true,
                });
                return;
            } catch (err) {
                debugWarn('Final heartbeat keepalive failed', err);
            }
        }
        void addToQueue({ kind: 'heartbeat', payload, createdAt: Date.now() });
    };

    const processNavigation = async (path: string) => {
        if (path === currentPathRef.current) return;
        if (navInProgressRef.current) {
            pendingNavPathRef.current = path;
            return;
        }
        navInProgressRef.current = true;
        try {
            await sendFinalHeartbeat();
            await trackVisit(path);
        } finally {
            navInProgressRef.current = false;
            const pending = pendingNavPathRef.current;
            if (pending && pending !== currentPathRef.current) {
                pendingNavPathRef.current = null;
                void processNavigation(pending);
            } else {
                pendingNavPathRef.current = null;
            }
        }
    };

    const handleNavigation = async () => {
        await processNavigation(getPath());
    };

    useEffect(() => {
        const globalState = getGlobalState();
        globalState.sessionId = getSessionId();
        if (debug) {
            globalState.debugUsers += 1;
            globalState.debugEnabled = true;
        }
        sessionStartRef.current = Date.now();
        const initialPath = getPath();

        initLeaderElection(log);
        loadDetectionUtils();
        trackVisit(initialPath);
        log('Init:', { session: globalState.sessionId, tab: globalState.tabId, path: initialPath });

        // Adaptive heartbeat
        const scheduleHeartbeat = () => {
            hbTimeoutRef.current = setTimeout(async () => {
                await sendHeartbeat();
                scheduleHeartbeat();
            }, computeInterval(sessionStartRef.current));
        };
        scheduleHeartbeat();

        // History API patch (shared across hooks)
        registerNavigationHandler(handleNavigation);
        ensureHistoryPatched(log);

        let scrollRafId: number | null = null;
        const onScroll = () => {
            if (scrollRafId !== null) return; // Already scheduled
            scrollRafId = requestAnimationFrame(() => {
                scrollRafId = null;
                maxScrollRef.current = Math.max(maxScrollRef.current, getScrollPercent());
                hasActivityRef.current = true;
                lastActivityRef.current = Date.now();
            });
        };
        window.addEventListener('scroll', onScroll, { passive: true });

        const markActivity = () => { hasActivityRef.current = true; lastActivityRef.current = Date.now(); };
        const activityEvents = ['mousemove', 'keydown', 'click', 'touchstart'] as const;
        activityEvents.forEach(e => window.addEventListener(e, markActivity, { passive: true }));

        const onVisibility = async () => {
            if (document.visibilityState === 'hidden') {
                hasActivityRef.current = false;
                await sendFinalHeartbeat();
            } else {
                lastHbTimeRef.current = Date.now();
                fractionalSecondsRef.current = 0;
                lastActivityRef.current = Date.now();
                hasActivityRef.current = true;
                await flushQueue(supabase, isFlushingRef, safeRpc);
            }
        };
        document.addEventListener('visibilitychange', onVisibility);

        const onOnline = () => flushQueue(supabase, isFlushingRef, safeRpc);
        window.addEventListener('online', onOnline);

        const onPageHide = () => { sendFinalHeartbeat({ fireAndForget: true }); };
        window.addEventListener('pagehide', onPageHide);

        const onFreeze = () => {
            hasActivityRef.current = false;
            sendFinalHeartbeat({ fireAndForget: true });
        };
        const onResume = () => {
            lastHbTimeRef.current = Date.now();
            fractionalSecondsRef.current = 0;
            lastActivityRef.current = Date.now();
            hasActivityRef.current = true;
            flushQueue(supabase, isFlushingRef, safeRpc).catch(() => { });
        };
        document.addEventListener('freeze', onFreeze);
        document.addEventListener('resume', onResume);

        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) {
                lastHbTimeRef.current = Date.now();
                fractionalSecondsRef.current = 0;
                lastActivityRef.current = Date.now();
                hasActivityRef.current = true;
            }
        };
        window.addEventListener('pageshow', onPageShow);

        return () => {
            if (hbTimeoutRef.current) clearTimeout(hbTimeoutRef.current);
            if (scrollRafId) cancelAnimationFrame(scrollRafId);
            sendFinalHeartbeat({ fireAndForget: true });
            if (debug) {
                globalState.debugUsers = Math.max(0, globalState.debugUsers - 1);
                globalState.debugEnabled = globalState.debugUsers > 0;
            }
            unregisterNavigationHandler(handleNavigation);
            teardownHistoryPatch();
            teardownLeaderElection(log);
            window.removeEventListener('scroll', onScroll);
            activityEvents.forEach(e => window.removeEventListener(e, markActivity));
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('online', onOnline);
            window.removeEventListener('pagehide', onPageHide);
            document.removeEventListener('freeze', onFreeze);
            document.removeEventListener('resume', onResume);
            window.removeEventListener('pageshow', onPageShow);
        };
    }, [supabase, debug, excludePathsSignature, restUrl, anonKey]);
}

export default useAnalytics;
