# Prism Relay

**Prism Relay** is a tactile 60-second daily optical routing and efficiency puzzle built natively on **Devvit Web** for Reddit communities.

Every day at **00:00 UTC**, all players on the subreddit receive the exact same solver-verified 7×7 dual-wavelength optical bench. Route **Amber (A)** and **Cyan (C)** laser beams through mirrors (`/`, `\`) and perpendicular splitters (`+`), merge both beams onto **White (A+C)** photodiodes without cross-talk, and compete to hit or beat the mathematically verified **Par** optic count.

---

## Core Mechanics & Daily Community Loop

- **Zero-Tutorial Tactile Bench:** Beams trace live in real time on a high-DPI `<canvas>` with harmonic Web Audio API feedback as you place or cycle optics.
- **Mathematically Verified Par:** Every UTC daily seed is verified at generation time by an exact iterative-deepening ray-tracing solver (`src/shared/solver.ts`), guaranteeing 100% solvability, zero trivial 0–2 optic shortcuts, and at least one merged White (`A+C`) target.
- **Server-Side Anti-Cheat & Redis Telemetry:** Submissions to `POST /api/solve` re-run the shared deterministic ray tracer on the server before updating the subreddit's Redis sorted-set leaderboard, daily optic distribution histogram, and consecutive UTC streak counter.
- **Spoiler-Free Comment Sharing:** One click posts a crisp 3-line efficiency card (`PRISM RELAY #N · 🟧🟦⬜ · 4 optics (PAR 4 ★) · 38s · Top 7%`) directly to the post thread via `reddit.submitComment` (rate-limited to 1/user/day) without revealing a single board coordinate.
- **Auto Streak & Par Flair:** Players can claim subreddit user flair reflecting their active streak or Par mastery (`Par Solver ★`, `Relay Runner · 3d Streak`, `Optics Ace · 7d Streak`, `Prism Master · 14d Streak`).
- **14-Day Archive + Unlimited Practice:** Play yesterday's boards or spin up unlimited deterministic practice boards directly inside the post.

---

## Architecture

- `devvit.json` — Official Devvit Web v0.15.6 app manifest (`post`, `server`, `redis`, `reddit`, moderator menu item, `onAppInstall` trigger).
- `src/shared/` — Zero-dependency deterministic Mulberry32 PRNG, bounded 392-state ray tracer (`engine.ts`), exact minimal-optic solver & daily generator (`solver.ts`), and spoiler-free share card formatter (`shareFormat.ts`).
- `src/server/index.ts` — Express server running on `@devvit/web/server` (`GET /api/daily`, `POST /api/solve`, `POST /api/share-comment`, `POST /api/claim-flair`, plus `/internal/menu/post-create` and `/internal/on-app-install`).
- `src/client/` — React 19 + Vite high-DPI `<canvas>` UI with full keyboard navigation (Arrow keys + Space/Enter + `1`/`2`/`3` + `Z`/`R`/`H`), adaptive light/dark theme (including iframe `?theme=` / `postMessage` support), native `<dialog closedby="any">` modals with Safari backdrop fallback, and automatic standalone local preview mode.

---

## Quick Start & Verification

```bash
# Install dependencies
npm install

# Run 30-day solver, loop-safety, and server anti-cheat test suite
npm test

# Type-check and build both Devvit client (dist/client) and server (dist/server/index.cjs)
npm run typecheck
npm run build

# Preview locally in browser (standalone community simulator)
npm run preview:local
```

### Deploy Private Hackathon Build to Reddit (Devvit Web)

> Per Reddit's Game of the Day Hackathon guidelines, keep the app **private** (do not submit for public App Review).

```bash
npx devvit login
npm run build
npx devvit upload
npx devvit playtest <your-test-subreddit>
```
