# ARCHITECTURE.md — Software design

---

## 0. Three architectural principles

**1. Functional core, imperative shell.**
The algorithm is a pure function that knows nothing about databases, clocks, or networks. Everything dirty — I/O, transactions, realtime, race conditions — lives in the outer shell. The core is testable with zero mocks.

**2. The server is the sole referee when allocating players.**
This is the **only** place in the app that can break in a way that's hard to fix.

**3. Idempotency instead of permissions.**
22 people who know each other. Don't fight duplicate requests with a hierarchy — fight them by **making duplicates harmless**.

---

## 1. System context

```
   ┌─────────────┐         ┌─────────────┐
   │ 22 phones   │         │  Spectators │
   │ (have code) │         │  (no code)  │
   └──────┬──────┘         └──────┬──────┘
          │                       │
    WRITE │  READ           READ  │
          │   └───────────┬────────┘
          │               │
          ▼               ▼
   ┌─────────────┐   ┌──────────────────┐
   │  Next.js    │   │ Firestore        │
   │  Route      │   │ onSnapshot       │
   │  Handlers   │   │ (WebSocket)      │
   │  (Vercel)   │   └────────┬─────────┘
   └──────┬──────┘            │
          │ Admin SDK         │ client SDK (read-only, rules)
          ▼                   │
   ┌──────────────────────────┴──┐
   │       Firestore              │
   └──────────────────────────────┘
```

**Why reads DON'T go through Vercel:**
Polling every 3s × 22 people × 2 hours = **~50,000 invocations per session**. Vercel's free tier gives 100k/month → blown after two sessions.

Firestore's realtime listener connects the client straight to the database. Vercel only handles **writes** — a few hundred requests per session. Comfortably inside the free tier.

**Why writes MUST go through Vercel:** see §3.

---

## 2. Module layers

```
┌───────────────────────────────────────────────────────┐
│  app/  — React components, Tailwind                   │  ← dirty, changes constantly
│         Optimistic updates, onSnapshot subscription   │
├───────────────────────────────────────────────────────┤
│  app/api/  — Route Handlers                           │  ← dirty, but small
│         Transactions, idempotency, audit log          │
├───────────────────────────────────────────────────────┤
│  lib/firestore.ts  — the repository                   │  ← I/O
│         checkInBatch() · recordResult() · assignCourt │
├───────────────────────────────────────────────────────┤
│  lib/  — THE PURE CORE                                │  ← stable, tested
│         types.ts · rating.ts · matchmaking.ts         │
│         Imports nothing. Doesn't know about the DB.   │
│         Doesn't know about Date.now() (takes `now`    │
│         as a parameter).                              │
└───────────────────────────────────────────────────────┘
```

### The boundary that matters most: `lib/` must not know about the world

```ts
// RIGHT — pure, testable, deterministic
suggestMatch({ now, players, attendance, pairStats, config, busy, rng })

// WRONG — untestable, unreproducible
suggestMatch(sessionId)   // ← goes and queries the DB, calls Date.now(), calls Math.random()
```

**`now` and `rng` are parameters, not side effects.** That's why 20 unit tests run without a database, without a single mock, and produce **reproducible** results (`rng: () => 0.5`).

The three files in `lib/` are **the most valuable asset in this project** — they were validated by 30–40 simulation runs × 24 weeks. Everything else could be rewritten in a week. **Don't let them touch Firestore.**

---

## 3. THE DANGER ZONE — allocating players

This is the **only** part worth designing carefully. Everything else is CRUD.

### The failure

```
20:14:03  court 1 finishes → client A computes → "An, Binh, Cuong, Dung"
20:14:05  court 2 finishes → client B computes → "An, Binh, Em, Phong"
                                                  ↑↑  An and Binh taken TWICE
```

If clients pick their own players, this **will** happen — three courts, two hours, twenty rotations.

### The fix: one transaction, server decides

**With Firestore this is easier than with Postgres.** The entire live session state (22 people, 3 courts, the queue) fits in ONE document, ~5KB. Firestore's limit is 1MB.

The consequence: **a transaction on one document is atomic by definition.** No `SELECT ... FOR UPDATE`. No isolation levels to reason about. "Two phones both grab An and Binh" — **impossible**, because both read-and-write the same doc, and Firestore automatically retries the loser.

**The danger zone disappears.**

```ts
runTransaction(db, async tx => {
  const s = (await tx.get(sessionRef)).data();

  // The entire reason this transaction exists:
  const taken = four.filter(id => s.attendance[id]?.status !== 'AVAILABLE');
  if (taken.length) throw new ConflictError(taken);

  // Lock the four
  for (const id of four) attendance[id].status = 'PLAYING';

  tx.set(gameRef, {...});
  tx.update(sessionRef, { attendance, courts });
});
```

### Why does the client still send the four players up (instead of the server picking)?

Because the user can press **"Swap"** and pick their own. The server receives `four` from the client but **always re-validates** inside the transaction. Client proposes, server approves.

```
Client:  "Put An, Binh, Cuong, Dung on court 2."
Server:  "Checking... An is already PLAYING. 409. Refetch."
```

### Firestore's rule you must not violate

**All reads must complete before any write** inside a transaction. The existing code obeys this. If it gets refactored, it's easy to break — and it throws at runtime, not compile time.

---

## 4. Idempotency — three people tap at once

```
POST /api/session/:id/result
     { gameId: 'g47', courtIdx: 2, winner: 'A' }
```

```ts
// Idempotency key = gameId, NOT a request id.
// Three people tap "Team A won" on court 2 → same gameId → same result.
if (!game)                  return 404;
if (game.status === 'VOID') return { ok: true };   // voided, ignore
if (game.winner !== null)   return { ok: true };   // ← ALREADY RECORDED. Not an error.

// Not yet recorded → record it
```

**All three get `200 OK`. Nobody sees an error. Nobody knows they were second.**

This is why **optimistic updates** are safe in the UI: the user taps → sees feedback instantly → if they tap again out of impatience, the second tap is harmless.

Without idempotency: user taps, sees nothing (slow network), taps again → **two games recorded** → rating corrupted, game counts wrong.

---

## 5. State machines

### A player during a session

```
                  ┌──────────────┐
     check-in  →  │  AVAILABLE   │ ←──────────────┐
                  └──┬────────┬──┘                │
                     │        │                   │
         assigned    │        │  taps "Pause"     │  "I'm back"
                     ▼        ▼                   │
              ┌──────────┐  ┌────────┐            │
              │ PLAYING  │  │ PAUSED │────────────┘
              └────┬─────┘  └───┬────┘
                   │            │
      court done   │            │  taps "Leaving"
                   │            ▼
                   │       ┌────────┐
                   └──────►│  LEFT  │
                           └────────┘
                    (only via explicit tap)
```

**Only `AVAILABLE` enters the queue.** `buildQueue()` filters on exactly this — no special rule needed for "just came off court" (they return to `AVAILABLE` with `freeAt = now`, and the games-played gate pushes them to the back automatically).

**No automatic timeouts.** Someone in the toilet for 40 minutes stays `PAUSED` until a human taps. The app does not guess.

### A court

```
   EMPTY ──assign──► IN PLAY ──result──► EMPTY
     │                  │
     │                  └──void──► EMPTY   (match voided, no rating update)
     │
     └── mode = ASSIGN → show SUGGESTION (locks nobody)
```

**A suggestion LOCKS NOBODY.** It's only a displayed proposal. People are locked (`PLAYING`) only when someone taps **"Take court."**

Consequence: two courts can **suggest the same person**. That's fine. Whoever taps first wins; the other court gets a 409 and recomputes its suggestion.

---

## 6. Three modes — a different state machine

```
     ┌─────┐  on    ┌────────┐  on    ┌────────┐
     │ OFF │ ─────► │ RECORD │ ─────► │ ASSIGN │
     └─────┘ ◄───── └────────┘ ◄───── └────────┘
              off               off
```

Switchable **at any time, mid-session**. No state is ever stuck.

| | Read DB | Write game | Run `suggestMatch` | Update rating |
|---|---|---|---|---|
| **OFF** | – | – | – | – |
| **RECORD** | ✓ | ✓ | – | ✓ |
| **ASSIGN** | ✓ | ✓ | ✓ | ✓ |

**RECORD mode still updates the rating and `pairStats`.** That's its entire value — the app "sees" the manual hour even though it doesn't control it.

Without it: the app switches on for hour two, sees `gamesToday = 0` for everyone, and treats someone who's played 3 games identically to someone who's played none.

---

## 7. Degraded modes — hall wifi WILL fail

Design for failure, not for the happy path.

| Situation | What the app does |
|---|---|
| **Offline < 15s** | Optimistic update stands. Request auto-retries. Say nothing. |
| **Offline > 15s** | Red dot. **Disable the result buttons.** Show *"Offline. What you're seeing is stale."* |
| **Realtime drops** | Firestore auto-reconnects. On reconnect → refetch the whole state (don't merge deltas). |
| **Server 500** | Roll back the optimistic update. Toast: *"Couldn't save. Retry?"* |
| **409 (players taken)** | Refetch, recompute the suggestion, show the new one. **Show the user no error** — this is normal. |
| **Algorithm returns `null`** | Fewer than 4 people free. Show *"Waiting for another court."* |
| **Algorithm does something stupid** | **"Manual teams" button** → switch to RECORD mode. The session carries on. Data still collected. |

### The "Manual teams" button is a feature, not a fallback

Without it, one small bug wrecks the badminton session for 22 people, and **you will never dare try again.**

It matters more than the algorithm.

---

## 8. Undo — 60 seconds, replaces permissions

```
sessions/{sid}/audit/{logId}:  at · actor · action · payload
```

Every action writes to `audit` **with enough data to reverse it**:

```jsonc
{
  "action": "RESULT",
  "payload": {
    "gameId": "g47",
    "winner": "A",
    "before": {                     // ← enough to roll back
      "ratings": [ {"id":"p1","mu":52.1,"sigma":6.2}, ... ],
      "pairs": [ {"key":"p1|p2","partnered":3}, ... ],
      "attendance": [ {"id":"p1","gamesToday":2,"freeAt":...} ]
    }
  }
}
```

`POST /api/session/:id/undo { auditLogId }` → a transaction that writes `before` back.

**Why store `before` instead of computing the inverse?**
TrueSkill **has no inverse function** — you cannot derive the old `mu` from the new one. You must snapshot. For 4 players that's a few hundred bytes. Cheap.

**Only the last action is undoable**, within 60 seconds. No undo tree. Not needed.

---

## 9. Data flow — one complete request

```
[User taps "Hai & Binh won"]
        │
        ├─► UI updates IMMEDIATELY (optimistic)   ← doesn't wait for the server
        │      court 2 → empty, small spinner
        │
        └─► POST /api/session/s1/result
                 { gameId: 'g47', winner: 'B', actor: 'Minh' }
                        │
                        ▼
              ┌─────────────────────────────────┐
              │  runTransaction                 │
              │                                 │
              │  1. does g47 have a winner?     │
              │       yes → return, no-op       │ ← IDEMPOTENT
              │       no  → continue            │
              │                                 │
              │  2. read session + pairStats    │  (all reads first!)
              │                                 │
              │  3. game.winner = 'B'           │
              │     updateRatings()  [pure core]│ ← THE PURE CORE
              │     pairStats += 1               │
              │     4 players → AVAILABLE        │
              │     freeAt = now                 │
              │     gamesToday++                 │
              │     court[2].gameId = null       │
              │                                 │
              │  4. audit += { before: ... }    │
              └─────────────────────────────────┘
                        │
        ┌───────────────┴───────────────┐
        │                               │
        ▼                               ▼
[Return new state to the tapper]  [Firestore pushes to
                                   the other 21 phones]
```

If `mode = ASSIGN`, the client then calls `GET /api/session/s1/suggest?court=2`.

**The suggestion is a SEPARATE request, not part of the write transaction.** Because a suggestion locks nobody — it's only display.

---

## 10. Testing strategy

```
lib/          →  unit tests, pure, no mocks, deterministic (rng injected)
                 20 tests. Runs in 1 second.
                 ALREADY EXISTS. Don't break it.

lib/firestore →  integration tests against the Firestore emulator
                 Test exactly ONE thing: two concurrent requests
                 never grab the same player.

app/          →  don't test. Changes constantly, low value.
                 Instead: run a real session.
```

### The concurrency test — the only one worth writing at the server layer

```ts
test('two courts finish at once → nobody gets picked twice', async () => {
  const [r1, r2] = await Promise.allSettled([
    assignCourt(db, sid, { courtIdx: 0, four: ['An','Binh','Cuong','Dung'], ... }),
    assignCourt(db, sid, { courtIdx: 1, four: ['An','Binh','Em','Phong'], ... }),
  ]);

  const ok = [r1, r2].filter(r => r.status === 'fulfilled');
  const conflict = [r1, r2].filter(r => r.status === 'rejected');

  expect(ok).toHaveLength(1);        // exactly ONE succeeds
  expect(conflict).toHaveLength(1);  // the other is cleanly rejected
});
```

If this test passes, the hardest part of the app is correct.

---

## 11. What this architecture deliberately does NOT have

| Not present | Why |
|---|---|
| Login / JWT / sessions | 22 people who know each other. `localStorage` + one shared code. |
| Roles / permissions | 60-second undo + audit log replace them entirely. |
| Message queue | No background jobs. Everything is synchronous within a request. |
| Cache layer | 22 people. Firestore is fast enough. |
| Microservices | One Next.js app. |
| Heavy ORM | Firebase Admin SDK + typed docs. |
| Hand-rolled WebSockets | `onSnapshot` handles it. |
| Polling | See §1 — it kills the Vercel free tier. |
| Service worker / offline-first | Writes must be online (the server is the referee). Just retry + show the connection state. |

**Every line above is a week you don't have to spend.**

---

## 12. Architectural risks, by severity

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Nobody records results** → queue is wrong → app is stale → abandoned | Not a technical problem. Big button, one tap, anyone can press it. Measure **recording latency** at the trial session. |
| 2 | **Race condition on allocation** | Single-doc Firestore transaction. One integration test. |
| 3 | **Double-tap → two games recorded** | Idempotency on `gameId`. |
| 4 | **Wifi dies mid-session** | Connection dot + disabled write buttons + retry. |
| 5 | **`lib/` gets coupled to Firestore** | Code review. If `lib/{types,rating,matchmaking}.ts` imports anything but `./types` → wrong. |
| 6 | **Vercel free tier exhausted** | `onSnapshot` instead of polling. Only writes go through Vercel. |

Risk #1 is **outside the architecture's control**, and it is the largest one.

---

## 13. One-page summary

```
PURE CORE (lib/)           ←  done, tested, DO NOT TOUCH
  types · rating · matchmaking
  Imports nothing. Takes `now` and `rng` as parameters.

DIRTY SHELL (app/, lib/firestore.ts)   ←  the part you build
  Read:   client ↔ Firestore onSnapshot   (never through Vercel)
  Write:  client → Vercel Route Handler → Firestore transaction

THE DANGER ZONE: exactly ONE place
  runTransaction on sessions/{sid}
  → check the four are still AVAILABLE
  → lock them, create the game
  → commit
  Client proposes. Server approves.

THREE SAFETY VALVES
  Idempotent (gameId)   → tapping many times is harmless
  60-second undo        → replaces the permission system
  "Manual teams" button → algorithm breaks, session carries on
```