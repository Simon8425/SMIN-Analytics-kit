# Analytics Kit

Analytics you actually own.

A single React hook that captures page views, scroll depth, time-on-page, referrers, devices, and browsers — and stores it all in your Supabase Postgres. No third-party scripts, no cookie banners, no monthly fees.

## What makes it different

- **Cross-tab leader election** — BroadcastChannel protocol. Only one tab shouts. 90% fewer writes, no double-counted time.
- **Offline queue** — Events persist to `localStorage` when signal drops. Auto-flushes on reconnect.
- **Keepalive beacon** — `fetch` with `keepalive: true` on the final heartbeat. Bounce rates survive tab death.
- **SPA-native** — Patches the History API once. Catches every `pushState`, `replaceState`, and hash change.
- **150+ referrer taxonomy** — Auto-detects source and category (Search, Social, Email, Messaging, …).
- **Lazy-loaded detection** — Device, OS, and browser parsing loads alongside the first visit.
- **Resilient RPCs** — 8-second timeouts, circuit breaker, UUID idempotency.

## Get started in 30 seconds

```sh
cp -r src/ /path/to/your-project/src/analytics-kit
# Run both SQL scripts from ANALYTICS_SETUP.md in Supabase SQL Editor
```

```tsx
import { useAnalytics } from './analytics-kit';

export default function App() {
  useAnalytics({ supabase, debug: false });
  return <YourApp />;
}
```

Done. The rest is Postgres — query, JOIN, aggregate, dashboard.

## What you get

| Category | Fields |
|---|---|
| **Visit** | `path`, `referrer` (sanitized), `referrer_source`, `referrer_category` |
| **Device** | `mobile`, `desktop`, `tablet`, `console`, `bot`, `vr_ar`, `smart_tv`, `wearable` |
| **OS** | iOS, macOS, Windows, Android, Ubuntu, Arch, Kali, Fedora, NixOS … 22+ distros |
| **Browser** | Edge, Chrome, Safari, Firefox, Brave, Opera, Samsung, Vivaldi, Facebook, Instagram … |
| **Engagement** | `scroll_percentage`, `added_seconds` (active time only) |
| **Identity** | Anonymous `session_id` (UUID, no PII) |

> **Not tracked:** IP addresses, user IDs, cross-site identifiers, fingerprinting.

## Why this beats the default

| | **This Kit** | **GA4** | **PostHog / Plausible** |
|---|---|---|---|
| Where your data lives | **Your Postgres** | Google's servers | Their servers |
| Monthly cost (100k visits) | **$0** | Free (sampled) | ~$20+ |
| Cookie banner needed | **No\*** | Mandatory | Depends |
| Ad-blocker impact | **None** (first-party) | Blocked often | Partial |
| Offline support | **Yes** (queue) | No | Varies |
| SPA routes | **Automatic** | Manual | Manual/Automatic |
| SQL on your data | **Native** | Not possible | Export required |
| Bundle impact | **~10 KB** (gzip) | ~45 KB | ~15–20 KB |

*\*Strictly necessary storage only (session management, offline queue). Check local laws.*

## Why it exists

Most analytics tools rent your data back to you. This kit doesn't. Your data lives in your Postgres, so you can query it, JOIN it, export it, or delete it whenever you want.

**[Full documentation →](DOCUMENTATION.md)**
**[Database setup →](ANALYTICS_SETUP.md)**

MIT
