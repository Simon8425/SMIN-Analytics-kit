# Analytics Kit — Documentation

This is the full technical reference for Analytics Kit: a self-hosted analytics hook for React + Supabase.

## Why this exists

| Pain point | How this kit solves it |
|---|---|
| Data lives on someone else's servers | Runs on your Supabase Postgres |
| Monthly cost scales with traffic | Storage-only cost; no analytics vendor fees |
| Blocked by ad-blockers | First-party same-origin requests |
| Cookie banners required | Strictly necessary storage only |
| 10 tabs = 10× write amplification | Cross-tab leader election |
| Offline / flaky connections | Persistent localStorage queue |
| Missed final "unload" event | `fetch` keepalive beacon |
| SPA route changes ignored | History API patch |

## Core features

| # | Feature | What it does |
|---|---|---|
| 1 | **Cross-tab leader election** | `BroadcastChannel` elects one leader per browser. Only the leader sends heartbeats. |
| 2 | **Session singleton** | One `session_id` shared across all tabs via `window['__analytics_v2__']`. |
| 3 | **Offline-first queue** | Events queue to `localStorage` when offline; mutex-locked for multi-tab safety. |
| 4 | **Keepalive beacon** | Final heartbeat uses `fetch(..., { keepalive: true })` to survive tab close. |
| 5 | **SPA-native routing** | Patches `pushState`/`replaceState`/`popstate`; supports `#/` and `#!` routes. |
| 6 | **Lazy-loaded detection** | Device, OS, browser, and referrer parsing load alongside the first visit. |
| 7 | **Resilient RPCs** | 8 s timeout guard, circuit breaker (3 failures → 30 s cooldown), UUID idempotency. |
| 8 | **PII-safe referrers** | 15+ sensitive query params stripped client-side; server strips again as defense-in-depth. |
| 9 | **Accurate active time** | 60 s activity timeout pauses time accumulation for idle tabs. |
| 10 | **Adaptive sampling** | Heartbeat drops from 3 s to 6 s after 10 minutes, cutting long-session DB load by 50%. |
| 11 | **Dev-mode dedup** | Suppresses duplicate visits within 1 s under React StrictMode. |

## Architecture

```
                    ┌─────────────────────────────┐
                    │  useAnalytics({ supabase }) │
                    │      One hook. All tabs.    │
                    └────────────┬────────────────┘
                                 │
            ┌────────────────────┼────────────────────┐
            │                    │                    │
     ┌──────▼──────┐    ┌───────▼───────┐    ┌───────▼───────┐
     │ Leader      │    │ Session       │    │ History       │
     │ Election    │    │ Singleton     │    │ Patch         │
     │ (Broadcast) │    │ (window)      │    │ (SPA routes)  │
     └──────┬──────┘    └───────┬───────┘    └───────┬───────┘
            │                   │                    │
            └───────────────────┼────────────────────┘
                                │
                       ┌────────▼────────┐
                       │  Event Router   │
                       │  visit / beat   │
                       └────────┬────────┘
                                │
                 ┌──────────────┼──────────────┐
                 │              │              │
          ┌──────▼───┐   ┌─────▼──────┐  ┌────▼──────┐
          │ Circuit  │   │ Offline    │  │ Keepalive │
          │ Breaker  │   │ Queue      │  │ Beacon    │
          │ + Timeout│   │ (ls+lock)  │  │ (fetch)   │
          └──────┬───┘   └─────┬──────┘  └────┬──────┘
                 │             │              │
                 └─────────────┼──────────────┘
                               │
                      ┌────────▼────────┐
                      │  Supabase RPC   │  ← lazy-loaded detection
                      │  your Postgres  │    (device, OS, browser)
                      └─────────────────┘
```

## Server-side

Three tables. Seven RPCs. Zero external dependencies.

| Object | Purpose |
|---|---|
| `analytics_visits` | One row per page view, idempotent by `event_id` |
| `analytics_heartbeats` | One row per heartbeat batch (seconds + scroll %) |
| `analytics_daily_stats` | Pre-aggregated daily visit + unique counts |
| `track_visit` | Idempotent insert + atomic daily-stats upsert via `pg_advisory_xact_lock` |
| `track_heartbeat` | Idempotent insert, no-op on replay |
| `get_analytics_stats` | Dashboard tiles: visitors, bounce, avg duration, active now |
| `get_top_referrers` | Top N traffic sources (7 d) |
| `get_device_stats` / `get_os_stats` | 30-day device/OS distribution |
| `get_analytics_trend` | Time-series with hour/day/month buckets |

> **Why advisory locks?** Two concurrent `track_visit` calls for the same session race on the daily-stats upsert. `pg_advisory_xact_lock(hashtext(session_id))` serializes them per-session with zero deadlock risk.

## Implementation

### 1. Run the SQL

Open Supabase SQL Editor and run the two scripts from [`ANALYTICS_SETUP.md`](ANALYTICS_SETUP.md):
- Step 1: tables + indexes + RLS
- Step 2: RPC functions

### 2. Add the hook

```tsx
import { useAnalytics } from './analytics-kit';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY
);

export default function App() {
  useAnalytics({
    supabase,
    debug: false,
    excludePaths: ['/admin', '/dashboard'],
    restUrl: import.meta.env.VITE_SUPABASE_URL, // enables unload beacon
    anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY,
  });

  return <YourApp />;
}
```

### 3. Query your data

```sql
-- Top pages by unique visitors (last 7 days)
SELECT path, COUNT(DISTINCT session_id) AS uniques
FROM analytics_visits
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY path
ORDER BY uniques DESC
LIMIT 10;

-- Bounce rate by traffic source
SELECT
  referrer_source,
  COUNT(DISTINCT session_id) AS sessions,
  ROUND(
    100.0 * COUNT(DISTINCT session_id) FILTER (
      WHERE COALESCE((
        SELECT SUM(added_seconds) FROM analytics_heartbeats h
        WHERE h.session_id = v.session_id
      ), 0) < 30
    ) / NULLIF(COUNT(DISTINCT session_id), 0), 1
  ) AS bounce_pct
FROM analytics_visits v
WHERE created_at >= NOW() - INTERVAL '7 days'
GROUP BY referrer_source
ORDER BY sessions DESC;
```

### 4. Production hardening

From [`ANALYTICS_SETUP.md`](ANALYTICS_SETUP.md) Step 2b:
- Restrict RLS to `anon` + `authenticated` roles.
- Add a retention job (`analytics_purge_old()`).
- Add per-session rate limiting if you expect abuse.

## Bundle & performance

| Metric | Value |
|---|---|
| Initial JS (eager, gzip) | **~6 KB** (hook + queue + leader election) |
| Lazy chunk (gzip) | ~3 KB (detection utilities) |
| Network per visit | 1 RPC (~300 B payload) |
| Network per heartbeat | 1 RPC / 3–6 s |
| DB writes per active user | 1 leader tab = ~20 writes/min |
| Ad-blocker impact | **None** (first-party same-origin requests) |

## What's tracked

| Category | Fields |
|---|---|
| **Visit** | `path`, `referrer` (sanitized), `referrer_source` (Google, Twitter, etc.), `referrer_category` (Search, Social, Email, …) |
| **Device** | `device` (mobile / desktop / tablet / console / bot / vr_ar / smart_tv / wearable) |
| **OS** | `os` (iOS, Android, Win10/11, macOS, Ubuntu, Arch, Kali, …) |
| **Browser** | Edge, Chrome, Safari, Firefox, Brave, Opera, Samsung, Vivaldi, … |
| **Engagement** | `scroll_percentage` (max), `added_seconds` (active time only) |
| **Identity** | Anonymous `session_id` (UUID, no PII) |

> **Not tracked:** IP addresses, user IDs, cross-site identifiers, fingerprinting. GDPR/CCPA-friendly by design.

## License

MIT — fork it, ship it, own your data.
