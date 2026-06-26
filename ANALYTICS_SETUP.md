# Analytics Setup Guide (Supabase/Postgres)

This guide provides the SQL to set up the backend for the `useAnalytics` hook.
It works on Supabase (Postgres + PostgREST RPC) and other Postgres providers.
If you are not using Supabase, you will need to expose these functions via your API and adapt the hook.

## Quick Summary
- Tables: `analytics_visits`, `analytics_heartbeats`, `analytics_daily_stats`
- RPCs: `track_visit`, `track_heartbeat`, `get_analytics_stats`, `get_top_referrers`, `get_device_stats`, `get_os_stats`, `get_analytics_trend`
- Optional hardening: referrer sanitization, rate limiting, retention policy, stricter RLS

## Prerequisites
- Postgres 12+ (Supabase or any Postgres host)
- Ability to run SQL scripts in the target database

## AI Agent Setup (Supabase MCP)
If you are an agent using the Supabase MCP server, read this file and then run Step 1 SQL followed by Step 2 SQL in order.

## Security Notes
- The RLS policies below are permissive so browser clients can write analytics directly.
- For production, consider restricting reads/writes to `anon`/`authenticated` or proxying through your backend.
- If you restrict policies, make sure `track_visit` can still upsert `analytics_daily_stats`.
- The client sanitizes referrers, but the database script below also strips query/hash for defense-in-depth.
- Consider adding rate limiting and retention jobs for abuse resistance and storage control.

---

## Step 1: Create Tables + RLS

Run this script first to create the tables, indexes, and row-level security policies.

```sql
-- ============================================
-- Analytics Tables for useAnalytics
-- ============================================

-- Visits table - tracks pageviews
CREATE TABLE IF NOT EXISTS analytics_visits (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  user_agent TEXT,
  referrer TEXT,
  referrer_source TEXT,
  referrer_category TEXT,
  browser TEXT,
  device TEXT,
  os TEXT,
  event_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Heartbeats table - tracks time on page
CREATE TABLE IF NOT EXISTS analytics_heartbeats (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  path TEXT NOT NULL,
  scroll_percentage INTEGER NOT NULL DEFAULT 0,
  added_seconds INTEGER NOT NULL,
  event_id TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Daily stats table - aggregated metrics
CREATE TABLE IF NOT EXISTS analytics_daily_stats (
  date DATE PRIMARY KEY,
  visits BIGINT NOT NULL DEFAULT 0,
  unique_visitors BIGINT NOT NULL DEFAULT 0
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_analytics_visits_session ON analytics_visits(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_visits_path ON analytics_visits(path);
CREATE INDEX IF NOT EXISTS idx_analytics_visits_created ON analytics_visits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_analytics_visits_referrer_source ON analytics_visits(referrer_source);
CREATE INDEX IF NOT EXISTS idx_analytics_visits_device ON analytics_visits(device);
CREATE INDEX IF NOT EXISTS idx_analytics_visits_os ON analytics_visits(os);

CREATE INDEX IF NOT EXISTS idx_analytics_heartbeats_session ON analytics_heartbeats(session_id);
CREATE INDEX IF NOT EXISTS idx_analytics_heartbeats_path ON analytics_heartbeats(path);
CREATE INDEX IF NOT EXISTS idx_analytics_heartbeats_created ON analytics_heartbeats(created_at DESC);

-- Row Level Security (RLS)
ALTER TABLE analytics_visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_heartbeats ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_daily_stats ENABLE ROW LEVEL SECURITY;

-- Public insert policy (allow anyone to write analytics)
CREATE POLICY "Allow public insert visits" ON analytics_visits
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Allow public insert heartbeats" ON analytics_heartbeats
  FOR INSERT TO public
  WITH CHECK (true);

-- Daily stats are updated by track_visit, so allow insert + update
CREATE POLICY "Allow public insert daily_stats" ON analytics_daily_stats
  FOR INSERT TO public
  WITH CHECK (true);

CREATE POLICY "Allow public update daily_stats" ON analytics_daily_stats
  FOR UPDATE TO public
  USING (true)
  WITH CHECK (true);

-- Public select policy (allow anyone to read stats)
CREATE POLICY "Allow public select visits" ON analytics_visits
  FOR SELECT TO public
  USING (true);

CREATE POLICY "Allow public select heartbeats" ON analytics_heartbeats
  FOR SELECT TO public
  USING (true);

CREATE POLICY "Allow public select daily_stats" ON analytics_daily_stats
  FOR SELECT TO public
  USING (true);
```

---

## Step 2: Create RPC Functions

Run this second script to create the RPC functions used by the frontend hook.

```sql
-- ============================================
-- Analytics RPC Functions for useAnalytics
-- ============================================

-- Sanitize referrers (defense-in-depth)
-- Strips query params and hash fragments to avoid storing tokens/PII.
CREATE OR REPLACE FUNCTION sanitize_referrer(p_referrer text)
RETURNS text
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_referrer IS NULL OR p_referrer = '' THEN
    RETURN NULL;
  END IF;
  RETURN regexp_replace(regexp_replace(p_referrer, '\\?.*$', ''), '#.*$', '');
END;
$$;

-- Track visit event
CREATE OR REPLACE FUNCTION track_visit(
  p_session_id text,
  p_path text,
  p_user_agent text,
  p_referrer text,
  p_referrer_source text,
  p_referrer_category text,
  p_browser text,
  p_device text,
  p_os text,
  p_event_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_visit_count int;
  v_is_new_visitor boolean;
  v_lock_key bigint;
  v_referrer text;
BEGIN
  -- Use advisory lock based on session_id hash to serialize concurrent calls for same session
  v_lock_key := hashtext(p_session_id);
  PERFORM pg_advisory_xact_lock(v_lock_key);

  v_referrer := sanitize_referrer(p_referrer);

  -- Insert visit record (idempotent by event_id)
  INSERT INTO analytics_visits (
    session_id,
    path,
    user_agent,
    referrer,
    referrer_source,
    referrer_category,
    browser,
    device,
    os,
    event_id,
    created_at
  ) VALUES (
    p_session_id,
    p_path,
    p_user_agent,
    v_referrer,
    p_referrer_source,
    p_referrer_category,
    p_browser,
    p_device,
    p_os,
    p_event_id,
    NOW()
  )
  ON CONFLICT (event_id) DO NOTHING;

  -- If this event was already recorded, stop here
  IF NOT FOUND THEN
    RETURN;
  END IF;

  -- Check if this is the first visit for this session today
  SELECT COUNT(*) INTO v_visit_count
  FROM analytics_visits
  WHERE session_id = p_session_id
  AND DATE(created_at) = CURRENT_DATE;

  v_is_new_visitor := (v_visit_count = 1);

  -- Update daily stats atomically
  INSERT INTO analytics_daily_stats (
    date,
    visits,
    unique_visitors
  ) VALUES (
    CURRENT_DATE,
    1,
    CASE WHEN v_is_new_visitor THEN 1 ELSE 0 END
  )
  ON CONFLICT (date)
  DO UPDATE SET
    visits = analytics_daily_stats.visits + 1,
    unique_visitors = analytics_daily_stats.unique_visitors + (CASE WHEN v_is_new_visitor THEN 1 ELSE 0 END);
END;
$$;

-- Track heartbeat (time on page)
CREATE OR REPLACE FUNCTION track_heartbeat(
  p_session_id text,
  p_path text,
  p_scroll_percentage int,
  p_added_seconds int,
  p_event_id text
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO analytics_heartbeats (
    session_id,
    path,
    scroll_percentage,
    added_seconds,
    event_id,
    created_at
  ) VALUES (
    p_session_id,
    p_path,
    p_scroll_percentage,
    p_added_seconds,
    p_event_id,
    NOW()
  )
  ON CONFLICT (event_id) DO NOTHING;
END;
$$;

-- Get analytics stats for dashboard
CREATE OR REPLACE FUNCTION get_analytics_stats(
  p_days_lookback int DEFAULT 7
) RETURNS TABLE (
  total_visitors bigint,
  bounce_rate numeric,
  avg_duration numeric,
  active_now bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  WITH sessions AS (
    SELECT DISTINCT session_id
    FROM analytics_visits
    WHERE created_at >= NOW() - INTERVAL '1 day' * p_days_lookback
  ),
  session_totals AS (
    SELECT session_id, SUM(added_seconds) AS total_time
    FROM analytics_heartbeats
    WHERE created_at >= NOW() - INTERVAL '1 day' * p_days_lookback
    GROUP BY session_id
  ),
  session_stats AS (
    SELECT s.session_id, COALESCE(t.total_time, 0) AS total_time
    FROM sessions s
    LEFT JOIN session_totals t ON t.session_id = s.session_id
  )
  SELECT
    (SELECT COUNT(*) FROM sessions) AS total_visitors,
    COALESCE(
      (SELECT ROUND(
        (COUNT(*) FILTER (WHERE total_time < 30)::numeric /
         NULLIF(COUNT(*), 0)) * 100, 1
      ) FROM session_stats),
      0
    ) AS bounce_rate,
    COALESCE(
      (SELECT ROUND(AVG(total_time), 0) FROM session_stats),
      0
    ) AS avg_duration,
    (SELECT COUNT(DISTINCT session_id)
     FROM analytics_visits
     WHERE created_at >= NOW() - INTERVAL '5 minutes'
    ) AS active_now;
END;
$$;

-- Get top referrers
CREATE OR REPLACE FUNCTION get_top_referrers(
  p_limit int DEFAULT 5
) RETURNS TABLE (
  source text,
  visits bigint
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(referrer_source, 'Direct') as source,
    COUNT(*) as visits
  FROM analytics_visits
  WHERE created_at >= NOW() - INTERVAL '7 days'
  GROUP BY COALESCE(referrer_source, 'Direct')
  ORDER BY visits DESC
  LIMIT p_limit;
END;
$$;

-- Get device stats
CREATE OR REPLACE FUNCTION get_device_stats() RETURNS TABLE (
  device_type text,
  pct numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(device, 'Other') as device_type,
    ROUND(COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER (), 0) * 100, 1) as pct
  FROM analytics_visits
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY device
  ORDER BY pct DESC;
END;
$$;

-- Get OS stats
CREATE OR REPLACE FUNCTION get_os_stats() RETURNS TABLE (
  os_name text,
  pct numeric
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    COALESCE(os, 'Other') as os_name,
    ROUND(COUNT(*)::numeric / NULLIF(SUM(COUNT(*)) OVER (), 0) * 100, 1) as pct
  FROM analytics_visits
  WHERE created_at >= NOW() - INTERVAL '30 days'
  GROUP BY os
  ORDER BY pct DESC;
END;
$$;

-- Get analytics trend data
CREATE OR REPLACE FUNCTION get_analytics_trend(
  p_period text DEFAULT 'daily',
  p_date_ref date DEFAULT CURRENT_DATE
) RETURNS TABLE (
  date_bucket timestamp with time zone,
  clicks bigint,
  uniques bigint,
  bounce_rate numeric
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_ts timestamptz;
  v_end_ts timestamptz;
  v_bucket text;
BEGIN
  -- Determine date range based on period
  CASE p_period
    WHEN 'daily' THEN
      v_start_ts := date_trunc('day', p_date_ref::timestamptz);
      v_end_ts := v_start_ts + INTERVAL '1 day';
      v_bucket := 'hour';
    WHEN 'weekly' THEN
      v_start_ts := date_trunc('day', p_date_ref::timestamptz) - INTERVAL '6 days';
      v_end_ts := date_trunc('day', p_date_ref::timestamptz) + INTERVAL '1 day';
      v_bucket := 'day';
    WHEN 'monthly' THEN
      v_start_ts := date_trunc('month', p_date_ref::timestamptz);
      v_end_ts := v_start_ts + INTERVAL '1 month';
      v_bucket := 'day';
    WHEN 'yearly' THEN
      v_start_ts := date_trunc('year', p_date_ref::timestamptz);
      v_end_ts := v_start_ts + INTERVAL '1 year';
      v_bucket := 'month';
    ELSE
      v_start_ts := date_trunc('day', p_date_ref::timestamptz);
      v_end_ts := v_start_ts + INTERVAL '1 day';
      v_bucket := 'hour';
  END CASE;

  RETURN QUERY
  WITH heartbeat_bucket AS (
    SELECT
      session_id,
      date_trunc(v_bucket, created_at) AS bucket,
      SUM(added_seconds) AS total_time
    FROM analytics_heartbeats
    WHERE created_at >= v_start_ts AND created_at < v_end_ts
    GROUP BY session_id, date_trunc(v_bucket, created_at)
  )
  SELECT
    date_trunc(v_bucket, v.created_at) as date_bucket,
    COUNT(*) as clicks,
    COUNT(DISTINCT v.session_id) as uniques,
    ROUND(
      (COUNT(DISTINCT v.session_id) FILTER (WHERE COALESCE(hb.total_time, 0) < 30)::numeric /
       NULLIF(COUNT(DISTINCT v.session_id), 0)) * 100, 1
    ) as bounce_rate
  FROM analytics_visits v
  LEFT JOIN heartbeat_bucket hb
    ON hb.session_id = v.session_id
   AND hb.bucket = date_trunc(v_bucket, v.created_at)
  WHERE v.created_at >= v_start_ts AND v.created_at < v_end_ts
  GROUP BY date_trunc(v_bucket, v.created_at)
  ORDER BY date_bucket;
END;
$$;
```

---

## Step 2b: Optional Hardening (Recommended for Production)

These are optional changes to reduce abuse risk and control data growth.

### 1) Restrict RLS to `anon` and `authenticated`
```sql
DROP POLICY IF EXISTS "Allow public insert visits" ON analytics_visits;
DROP POLICY IF EXISTS "Allow public insert heartbeats" ON analytics_heartbeats;
DROP POLICY IF EXISTS "Allow public insert daily_stats" ON analytics_daily_stats;
DROP POLICY IF EXISTS "Allow public update daily_stats" ON analytics_daily_stats;

CREATE POLICY "Allow anon/auth insert visits" ON analytics_visits
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow anon/auth insert heartbeats" ON analytics_heartbeats
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow anon/auth insert daily_stats" ON analytics_daily_stats
  FOR INSERT TO anon, authenticated
  WITH CHECK (true);

CREATE POLICY "Allow anon/auth update daily_stats" ON analytics_daily_stats
  FOR UPDATE TO anon, authenticated
  USING (true)
  WITH CHECK (true);
```

### 2) Retention job (example: 90 days)
```sql
CREATE OR REPLACE FUNCTION analytics_purge_old(p_days int DEFAULT 90)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM analytics_heartbeats WHERE created_at < NOW() - (p_days || ' days')::interval;
  DELETE FROM analytics_visits WHERE created_at < NOW() - (p_days || ' days')::interval;
END;
$$;
```
Schedule this daily using your platform’s cron/scheduler.

### 3) Rate limiting (simple per-session example)
If you want rate limiting, add a small table and check in `track_visit`/`track_heartbeat`.
Keep limits generous to avoid blocking legitimate traffic.

---

## Step 3: Frontend Integration

See the [README](README.md) for the hook setup and usage.

---

## Using Another Postgres Provider
- Keep the same tables and functions.
- Expose `track_visit` and `track_heartbeat` through your API.
- Adapt the hook to call your endpoints instead of `supabase.rpc`.
