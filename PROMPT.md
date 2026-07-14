# Badminton Queue — session manager for a badminton club

## CONTEXT

A badminton club: ~55 people in the group chat, ~22 play every Saturday 10am–12pm on 3 courts (sometimes 2–4). Doubles, games to 21, ~20 min per match. **Courts finish at different times** — there are no synchronised "rounds."

**The problem this app exists to solve:** everyone only ever plays with their friends. The app exists to **mix people up**.

**The central constraint:** the admin is also playing badminton. The app must run **without anyone leaving the court to tap a phone**.

**Reality:** the group will only use the app for **~1 hour per session** (the other hour they pick teams by hand), and possibly only 1–2 times a month.

## STACK

Next.js (App Router) + TypeScript + Tailwind · Firebase Firestore · Deploy on Vercel · Mobile-web

---

## READ BEFORE WRITING CODE

```
lib/types.ts        — data model
lib/rating.ts       — TrueSkill
lib/matchmaking.ts  — the two-tier engine
lib/firestore.ts    — transaction layer
firestore.rules
tests/engine.test.ts
ARCHITECTURE.md     — read §3 (the danger zone) and §7 (degraded modes) carefully
```

Run `npm i && npm test` → must be **20/20 pass**.

### ⛔ DO NOT MODIFY `lib/types.ts`, `lib/rating.ts`, `lib/matchmaking.ts`

These were validated by simulation (30–40 runs × 24 weeks) and 20 unit tests.

You **will** see things that look wrong and want to "improve" them. For example:
- *Why no decay on pair history?* → Tried it. Coverage **DROPPED** from 78.8% to 76.9%.
- *Why does the gate sort by games played, not wait time?* → Tried both. Games played is better, and **it's the thing people actually argue about**.
- *Why not use `ts-trueskill`?* → One fewer dependency in the container. 60 lines, readable.
- *Why denormalise players into the session doc?* → So a transaction touches 2 docs instead of 24.

**Every answer is in the comments.** Read them before proposing a change. If you still want to change something — ask me. Don't just do it.

---

## THREE NON-NEGOTIABLE PRINCIPLES

### 1. The server is the referee when allocating players

```
20:14:03  court 1 finishes → client A picks "An, Binh, Cuong, Dung"
20:14:05  court 2 finishes → client B picks "An, Binh, Em, Phong"
                                             ↑↑ An and Binh taken TWICE
```

The client **proposes**, the server **approves** inside a transaction. The entire live session state lives in ONE Firestore doc → the transaction is atomic by definition. See `assignCourt()` in `lib/firestore.ts`.

This is the **only** place in the app that can break in a way that's hard to fix.

### 2. Idempotency instead of permissions

Three people tap "Team A won" on court 2 → **all three get 200 OK**. Nobody sees an error. The idempotency key is `gameId`. See `recordResult()`.

Why this is mandatory: user taps, network is slow, nothing appears, they tap again → without idempotency **two games get recorded** → the rating is corrupted.

### 3. No accounts, no permissions

22 people who know each other. The threat model is *"someone taps the wrong thing"*, not *"someone attacks us"*. **Don't build a fortress to keep out the rain.**

- Open the app → pick your name → `localStorage`. Done.
- One access code for the whole group, never rotated. Enter once, forever.
- **Read: wide open** (no code needed). Paste the link into the group chat and anyone can watch — this is how the app spreads through the group.
- **Write: needs the code.** With the code you can write **everything**. No tiers.
- **60-second undo + audit log** is the entirety of the app's internal "security."

---

## WHO DOES WHAT

| Task | How often | Who |
|---|---|---|
| **Check-in** | once per session, at 10am | **Admin** — taps 22 names, ONE write |
| **Set the roster, switch modes** | once per session | Admin |
| **Record results** | 9–18 times, MID-session | **ANYONE with the code** |
| **Swap players, pause** | as needed | Anyone with the code |

**Recording results MUST NOT be admin-only.** The admin is on court 2 playing. If only the admin can record → the court finishes and 3 minutes later the app still thinks it's in play → the queue is wrong → people stop trusting it.

The people with the strongest incentive to tap are **the four who are next up on that court** — they're waiting, they want that court. The person who benefits is the person who taps. **This is the only kind of mechanism that survives contact with reality.**

In practice 3–5 people will use the app, not 22. That's already "fewer devices" — without creating a single point of failure.

---

## THREE MODES — the mode switch is a FIRST-CLASS feature

```
[ OFF ]   [ RECORD ]   [ ASSIGN ]
```

| Mode | The user | The app |
|---|---|---|
| **OFF** | Picks teams by hand | Nothing |
| **RECORD** | Picks by hand, taps 4 names + the winner | Counts games. Updates rating + pairStats. |
| **ASSIGN** | Taps "Take court" / "Swap" | Suggests 4 players + **the reason** |

**Switchable MID-SESSION.** Not a hidden setting. People will flip it constantly and skip whole weeks. The app must treat that as **normal**, not as an error.

### Why RECORD mode matters most

The group picks teams by hand for the first hour. If the app doesn't record that hour:

1. The app sees `gamesToday = 0` for everyone → it treats someone who's played 3 games identically to someone who's played none. **The games-played gate becomes meaningless.**
2. The whole-session spread becomes **2–6 games** instead of 2–5. The app can only balance what it can see.
3. The app **re-pairs An and Binh** — two people who partnered 20 minutes earlier → 22 people conclude *"this app is stupid."*

Cost: ~10 seconds per match.

---

## SCREENS

### `/` — the home screen, and `/session` — the live screen (separate routes)

**STATUS 2026-07-14: split into two routes.** This used to say "the
session (90% of the time is spent here)," then briefly became a single
router that showed one or the other depending on session state. Now
they're two separate URLs, on request — a home screen and a session
screen, not one page pretending to be both. `/` never shows courts;
`/session` never shows the mixing teaser.

**`/` — THE APP'S REAL HOME SCREEN**, not an empty state (the app runs
ONE HOUR A WEEK; it sleeps 167 hours, and this is where almost every
open lands):
```
┌──────────────────────────────┐
│      Badminton Queue         │
│                               │
│  ● Session is live           │  ← only if one is; links to /session
│  [ Go to session ]           │
│                               │
│  ── or, a DRAFT exists: ──   │
│  Next session                │
│  Sat 19 Jul · 22 players     │
│  [ Start session ]           │  ← MANAGER+ only; else "waiting
│                               │     for a manager" + Enter code.
│                               │     On success, jumps to /session.
│  ── or, no DRAFT exists: ──  │
│  No session yet              │
│  ─────────────────────────   │
│  🤝 You've played with       │  ← the discovery hook. See
│     14 of 21 people          │    LEADERBOARD.md §0 — this
│                               │    IS the retention channel.
│  [ Leaderboard ]  [My stats] │  ← the ONLY discovery path to
│                               │    /board and /me
│  [ Admin ]                   │  ← ADMIN only, recessed
└──────────────────────────────┘
```
If identity isn't known yet, an inline "Who are you?" strip replaces the
mixing teaser — it never blocks the rest of the page.

**`/session` — role MANAGER/ADMIN**, the full session screen. If no
session is LIVE when this route is visited, it just says so ("No
session right now" + a link back to `/`) — it doesn't try to be the
home screen too. **Three questions, only three.** If answering one
requires scrolling → the design is wrong.

1. *"When do I play?"* — 10 people are waiting
2. *"Who am I playing with, which court?"*
3. *"Court's done, record the result"*

```
┌──────────────────────────────┐
│  3 courts · 19 people  10:47●│  ← connection dot
├──────────────────────────────┤
│      you're 3rd in line      │
│         11 min               │  ← LARGEST TYPE ON SCREEN
│   court 2 finishing ·        │  ← an ACTION, not a datum
│   time for a drink           │
├──────────────────────────────┤
│  [Court 1] Tuan+Lan │ Hai+Binh│
│  [Tuan & Lan won][Hai & Binh won]   ← 56px tall
├──────────────────────────────┤
│  [Court 2 · SUGGESTED]       │
│  An+Nam  vs  Cuong+Ha        │
│  "An & Nam have never        │  ← MANDATORY (see below)
│   partnered. Cuong has       │
│   waited 19 min."            │
│  [ Take court ]    [ Swap ]  │  ← 2:1 ratio
├──────────────────────────────┤
│  Queue · 11 people           │
│  1 Cuong   19 min · 2 games  │  ← TWO numbers
│  2 Ha      17 min · 1 game   │
│  3 You     14 min · 2 games  │  ← highlighted
├──────────────────────────────┤
│  Pause me · Manual teams ·   │  ← recessed, at the foot
│  End session · Check people  │     (+Admin, ADMIN only)
│  in                          │
└──────────────────────────────┘
```

**No nav bar. No tabs. No hamburger.** This view is a destination — you're
standing on a court. The footer links are functional actions, not chrome
— deliberately no "← Home" here either, same reasoning.

**`/session`, role PLAYER (no code)** — the SAME screen, read-only:
courts, queue, and the "you're 3rd · 11 min" hero all render exactly as
above. What's missing: no record buttons, no mode switch (a plain "Mode:
Assign" readout instead), no check-in link, no End session. Pausing/
marking someone LEFT stays available — tap ANYONE's row in the queue,
no code needed; see CLAUDE.md "ROLES" for why that one is deliberately
open regardless of role. The footer becomes `[My stats] [Leaderboard]
[Enter code]` — a different context (a sofa on Tuesday vs. a court on
Saturday) gets different navigation, and this footer's job is
discovery, not control.

`End session` is MANAGER-reachable here (not just ADMIN via
`/admin/sessions`, same endpoint) — the person actually running
tonight's session shouldn't need the admin code to close it out.

### `/board` and `/me` — no code needed

The leaderboard (four tabs, Mixing default) and the personal stats page.
Discovered ONLY from the home screen above (and the post-session summary,
F-2) — never linked from the live session screen, so nobody's checking
their rank while standing on a court. See LEADERBOARD.md.

### `/checkin` — MANAGER+, one write, reached from `/session` when a session is live
Shows only the ~22 people on the roster + a button for "add someone not on the list" + "add guest."

### `/admin` and `/admin/*` — ADMIN only

Hub with three cards: new session, players, all sessions. **"Match
history" is NOT one of them — it doesn't exist yet.** `/admin/sessions`
lists SESSIONS (date, status, headcount); match history would be a list
of GAMES — what an admin opens when someone says "the app says I played
that match and I didn't" (a real conversation UC-1's mid-match swap will
eventually cause). Not a blocker, not built, don't assume it's there.

### `/admin/session/new` — Setup, 2 steps

**Step 1:** courts → headcount → the app shows `~3.3 games/person · sitting out 45% of the time`

Warn about the **FLOOR THRESHOLD** — the thing nobody thinks about:
```
pool = people present − (courts × 4)
pool < 8  →  the window shrinks  →  the algorithm loses its freedom  →  almost pure FIFO

Safe: people ≥ courts × 4 + 8
  2 courts → ≥ 16 · 3 courts → ≥ 20 · 4 courts → ≥ 24
```
**The paradox: TOO FEW PEOPLE breaks the app.** You need enough people sitting out to have something to mix.

**Step 2:** pick ~22 from the 55.
- **Primary path: PASTE the list from the group chat** → fuzzy-match names. The admin already has the list; don't make them type 22 names again. *If you only build one feature on this screen, build this.*
- The "not selected" list is **sorted by LONGEST ABSENT** (not alphabetically). This is the entire value the app adds.
- **NO ⚠️, no red.** The app doesn't know whether someone is absent because they lost the FCFS race or because they didn't want to come. Don't pretend to know. Just **sort**.
- Editable **mid-session** (someone cancels at 9:55am).

### `/admin/players` — CRUD for the 55 + **seed ranking**
Drag-drop ranking **WITHIN EACH DIVISION** (11 people per div, ~5 min). Do **NOT** ask them to rank all 22 at once — it's a harder task for a human, and the simulation shows it produces WORSE results (31.2% blowouts vs 24.7%). Call `seedMu(div, rank, divSize)`.

---

## THE REASON SENTENCE — the single most important feature

`suggestMatch()` returns `reason`. **Always show it. Never hide it.**

> *"An & Nam have never partnered. Cuong has waited longest (19 min)."*

Without that sentence the app is a **dictator**. With it, the app is a **referee**.
People argue with a referee — but people **accept** a referee.

The app only runs 1 hour a week. It has no time to "gradually earn trust." **It has to convince them on the very first match.**

The **"Swap"** button must be **always visible, never buried in a menu**. The paradox: precisely because people can see the Swap button, they rarely press it. Every press → log `accepted: false` to the audit log.

---

## API ROUTES (Firebase Admin SDK, server-side)

Last verified against the actual codebase 2026-07-13 — this list was stale
for a while (only 7 of the 14 routes below were ever documented; the rest
were built later and never backfilled here). /score added same day (UC-21).

```
POST   /api/session/:id/checkin  { playerIds: string[] }        → checkInBatch()
POST   /api/session/:id/result   { gameId, courtIdx, winner: 'A'|'B'|null,
                                    scoreLoser?, actor }         → recordResult()
POST   /api/session/:id/score    { gameId, scoreLoser: 0-29 }    → setGameScore()
                                                                    (UC-21 — patches an
                                                                     ALREADY-recorded game;
                                                                     never re-triggers rating)
POST   /api/session/:id/assign   { courtIdx, four, teamA, teamB, accepted,
                                    suggested?, reason?, assignedByApp, actor }
                                                                 → assignCourt()
POST   /api/session/:id/swap     { courtIdx, outId, inId, actor } → swapPlayerOnCourt()
GET    /api/session/:id/suggest?court=N                          → getSuggestion()
POST   /api/session/:id/mode     { mode }                        → setMode()
POST   /api/session/:id/pause    { playerId, paused }            → setPaused()
POST   /api/session/:id/leave    { playerId }                    → setLeft()
POST   /api/session/:id/undo     { auditLogId }                  → undoResult()
POST   /api/session/:id/guest    { name, gender }                → addGuest()
POST   /api/session/:id/roster   { courtCount, playerIds }       → createSessionRoster()
                                                                    (creates a NEW session; refuses
                                                                     if one already exists at :id)
PUT    /api/session/:id/draft    { courtCount, playerIds }       → setDraftRoster()
                                                                    (edits an existing DRAFT in place)
DELETE /api/session/:id/draft    (no body)                       → deleteDraftSession()
POST   /api/session/:id/start    (no body)                       → startSession()
                                                                    (refuses if another session is LIVE)
POST   /api/session/:id/end      (no body)                       → endSession()
```

Clients **read directly** via `onSnapshot()` — realtime, never through Vercel, zero invocations.

---

## BUILD ORDER (14 hours)

**Steps 1–3 are already a usable product.** If you only get through 1–3 by next week, the trial session **still works**.

| # | Task | Hours |
|---|---|---|
| 1 | Firebase setup + `/admin/players` + seed ranking + `/checkin` | 3 |
| 2 | **RECORD mode** — 3 courts, tap 4 names, tap the winner, undo, add guest | 4 |
| 3 | Queue + games played **shown publicly** + `onSnapshot` realtime | 2 |
| 4 | Rating running silently (`lib/rating.ts`), **completely hidden** from the UI | 2 |
| 5 | **ASSIGN mode** — `suggestMatch()` + the reason sentence + Swap button + logging | 3 |

**DO NOT BUILD (resist the temptation):**
leaderboard · win predictions · stats · charts · wildcards · chat · payments · logins · tournaments · native app · push notifications · badges · streaks · confetti · skeleton loaders · avatars

---

## THE FALLBACK MODE — mandatory, and higher priority than the algorithm

A **"Manual teams"** button in the corner (= switch to RECORD mode).

If the algorithm does something stupid in the first 15 minutes of the trial session → press this → the session carries on normally → **and you still collect the data**.

**Without this button, one small bug wrecks the badminton session for 22 people, and you will never dare try again.**

---

## UI — technical detail

- **Touch targets ≥ 56px.** Sweaty hands, out of breath, one-handed, standing up.
- **Buttons name the TEAM, not "Team A"** → *"Tuan & Lan won"*. Whoever taps shouldn't have to work out which side A was. **This mistake kills a lot of sports apps.**
- **Optimistic updates** — tapping gives instant feedback. (This is why idempotency is mandatory: people will tap again if nothing appears to happen.)
- **Connection dot** — green (synced) / grey (reconnecting) / red + **result buttons disabled** (offline >15s, *"what you're seeing is stale"*). Hall wifi **will** fail.
- **409 (players already taken)** → refetch, recompute the suggestion, **show no error**. This is normal.
- **No skeleton loaders.** The payload is a few KB — render immediately, or render the last known state.
- Mobile-first, works at 320px. `prefers-reduced-motion` → kill animations except the undo bar.

---

## MEASUREMENT — one number

> ### How many times did the person holding the phone press "Swap"?
> **< 30%** → the algorithm is fine · **> 60%** → something's wrong, and the audit log will show you where

Not coverage. Not Brier score. This is the **real** score, and it's the one number no simulation can hand you.

---

## GETTING STARTED

1. `npm i && npm test` → 20/20 pass
2. Read `ARCHITECTURE.md` §3 and §7
3. Read the comments in `lib/matchmaking.ts` — understand **why** the algorithm is two-tier
4. Firebase project + `firestore.rules`
5. Build **step 1**

Ask if anything is ambiguous — **don't guess**.