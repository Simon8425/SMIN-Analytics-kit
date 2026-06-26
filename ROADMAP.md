# Future Work

This project was built to solve the hardest infrastructure problems first: cross-tab deduplication, offline persistence, accurate exit tracking, SPA routing, and resilient RPCs. What follows are the natural next steps — features that would bring this from a focused analytics hook to a complete, production-grade analytics platform.

They are documented here not as promise of delivery, but to show that the architecture was designed with these extensions in mind.

---

## Custom event tracking

```ts
analytics.track('upgraded_plan', { plan: 'pro', value: 29 });
```

The kit currently captures page views and engagement. The next layer is a generic `track()` function for arbitrary events — button clicks, feature usage, API calls, form submissions. This is the single most impactful expansion: it transforms the kit from a page-view tracker into a product analytics tool.

The infrastructure is already there (offline queue, idempotency, circuit breaker, leader election). What's missing is a `analytics_events` table and a `track_event` RPC that takes a name and JSON payload.

**Difficulty:** Easy. 2 days.

---

## UTM campaign attribution

`utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content` are currently stripped by the server-side referrer sanitizer. Campaign attribution is invisible.

Fix: persist UTM params to a separate `analytics_campaigns` table or JSON column on the visit row, keeping them out of the general referrer field but making them queryable. This would unlock marketing-source analysis without a third-party tool.

**Difficulty:** Easy. 1 day.

---

## User identity linking

Anonymous sessions capture one side of the story. The ability to link a `session_id` to a `user_id` (after login or signup) unlocks post-conversion behavior analysis, cohort retention, and funnel analysis.

A `link_session(user_id)` RPC that updates existing visits and heartbeats with a user reference would be the cleanest approach — no changes to the existing analytics pipeline, just a late-binding identity join.

**Difficulty:** Easy. 1 day.

---

## Page-visit scoped engagement (sessions)

Currently, time-on-page is accumulated across all visits in a single session. Breaking heartbeats into page-level sessions would give per-page dwell time, pagination funnels, and scroll-depth-per-route.

The frontend already fires `track_visit` on each navigation and `sendFinalHeartbeat` on departure. The data is there to aggregate at query time — the gap is a pre-aggregated `analytics_page_sessions` table for dashboard-speed queries.

**Difficulty:** Medium. 2 days.

---

## Outbound link tracking

Clicks to external domains are invisible. An `onclick` capture on `<a href="...">` elements (with same-origin check) would fire a lightweight `track_outbound` event referencing the destination URL and referring page.

**Difficulty:** Easy. 1 day.

---

## File download detection

Similar to outbound links — detecting clicks on links ending in `.pdf`, `.zip`, `.csv`, `.mp4`, etc. and logging the download event. Trivial to implement as a generic `track()` extension once custom events exist.

**Difficulty:** Trivial. 0.5 days (additive to custom events).

---

## Engagement sessionization

A user opens a tab, reads for 2 minutes, gets distracted, and returns 10 minutes later to read more. Should that count as one session or two? Currently the kit treats the tab lifecycle as one session.

Adding a configurable grace period (e.g., 30 minutes of inactivity = new session) would make engagement metrics more realistic. The frontend already marks `lastActivityRef` — the logic to split sessions server-side during aggregation is straightforward.

**Difficulty:** Medium. 2 days (primarily analysis on which approach to take).

---

## Rate limiting by IP

The kit has a circuit breaker client-side, but no server-side rate limiting. A lightweight per-IP counter (using Supabase's `extensions` module or a simple `analytics_rate_limits` table) would protect against accidental or intentional flooding.

**Difficulty:** Easy. 1 day.

---

## Core Web Vitals capture

LCP, CLS, INP, FID, TTFB — loading the `web-vitals` library and dispatching results through the `track_event` pipeline would give performance metrics alongside engagement data. This is where analytics and observability converge.

**Difficulty:** Easy. 1 day (library integration).

---

## Dashboard views

The kit provides the RPCs (`get_analytics_stats`, `get_top_referrers`, `get_device_stats`, `get_analytics_trend`) but no UI. A lightweight React dashboard that queries these RPCs and renders charts (Recharts, Nivo, or similar) would turn the kit into a drop-in analytics solution, not just the data layer.

**Difficulty:** Medium. 3 days (charts + filtering + date range picker).

---

## Data export pipeline

A simple endpoint or API that exports analytics data as CSV/JSON for a given date range. Essential for compliance (right to portability) and for teams that want to run their own analysis in Python/R/Excel.

**Difficulty:** Easy. 1 day.

---

## Summary

| Feature | Effort | Impact |
|---|---|---|
| Custom events | 2 days | High — transforms the kit into a product analytics tool |
| UTM attribution | 1 day | High — unlocks campaign analysis |
| User identity linking | 1 day | High — enables funnel and cohort analysis |
| Engagement sessionization | 2 days | Medium — improves metric accuracy |
| Dashboard UI | 3 days | Medium — makes data accessible without SQL |
| CWV capture | 1 day | Medium — adds performance monitoring |
| Outbound links | 1 day | Low — nice to have |
| Rate limiting (server) | 1 day | Low — nice to have for protection |
| Data export | 1 day | Low — compliance and portability |
| File downloads | 0.5 days | Low — additive to custom events |

The foundation — cross-tab dedup, offline queue, SPA support, keepalive beacon, circuit breaker, idle detection, leader election, adaptive sampling — is the hard part. Everything above is straightforward extension work.
