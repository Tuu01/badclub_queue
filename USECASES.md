# USECASES.md — What actually happens in a badminton hall

The happy path will work by accident. **This file is everything else.**

Every scenario here is a real thing that happens on a Saturday morning. Each one has broken a real app.

**Format:** each case has a **Trigger** (what happens), **Expected** (what the app must do), **Breaks naively** (what happens if you don't handle it), and **Test** (how you know it works).

---

## The cast

| Who | When they touch the app | What they want |
|---|---|---|
| **Admin** | Friday night · Saturday 10am | Get it done and go play |
| **Waiting player** | Constantly, all session | *"When do I play?"* |
| **Player coming off court** | 9–18× per session | Tap once, walk away |
| **Spectator** (no code) | From home, occasionally | *"Is it still on?"* |
| **Nobody** | Most of the time | The app must survive being ignored |

**The admin is playing badminton.** Any design that needs the admin's attention mid-session is broken by definition. This is the constraint everything else bends around.

---

## Severity

| | |
|---|---|
| 🔴 **SILENT** | Corrupts data with no error. Nobody notices. Discovered months later. **These are the killers.** |
| 🟠 **LOUD** | Breaks visibly. Somebody shouts. Fixable on the spot. |
| 🟡 **FRICTION** | Works, but annoys. Erodes trust one cut at a time. |

**Fix 🔴 first, always.** A loud failure teaches you something. A silent one teaches you nothing and destroys everything.

---

# PART 1 — The happy path

Ten seconds. Then move on.

```
Fri 21:00  /admin → New session → Sat 19 Jul, 3 courts, 22 people
                  → paste roster from the group chat → Create → DRAFT

Sat 10:00  open / → "Next session: Sat 19 Jul · 22 players" → [Start session] → LIVE
Sat 10:02  [Check people in] → tap 22 names → Done → /
Sat 10:05  mode: RECORD.  Manual teams for hour one.
                          Per match: tap 4 names, tap the winner. ~10 sec.
Sat 11:00  mode: ASSIGN.  App suggests. [Take court] or [Swap].
Sat 12:00  [End session]. Close the tab.
```

If this is all you build, the app dies in week two.

---

# PART 2 — The silent killers 🔴

**These corrupt data with no error.** They are the only failures that truly matter, because every other failure announces itself.

---

## UC-1 · Four different people actually played 🔴

### Trigger
The app assigns An, Binh, Cuong, Dung to court 2. Dung is tying his shoelace. **Em steps in.** Nobody taps anything. The match is played. Someone records the winner.

### What just happened
`pairStats` now records that An–Binh partnered and played against Cuong–**Dung**. All four of those facts are false. Em's game isn't counted. Dung is credited with a game he never played.

### Why it's fatal
**`pairStats` is the entire point of the app.** It decides who plays with whom, forever. Corrupt it and the algorithm optimises against a fiction.

And nobody will ever notice. No error. No shout. Just a number — *"you've played with 14 of 21 people"* — that is quietly, permanently a lie.

### Expected
The four names on the court card are **tappable to swap**. One tap on a name → list of available players → pick the replacement. Three seconds, done courtside.

**Must work on a court that's already in play**, not only at assignment time.

### Breaks naively
There's no way to fix it, so nobody does. The data rots silently, week after week.

### Test
```
assign(court 2, [An, Binh, Cuong, Dung])
swapPlayer(court 2, Dung → Em)
recordResult(court 2, winner: 'A')

→ the game document shows [An, Binh, Cuong, Em]
→ pairStats reflects Em, not Dung
→ Dung's gamesToday does NOT increase
```

---

## UC-2 · Deleting a session 🔴

> **STATUS 2026-07-13: hit for real during development.** A bad `recordResult()`
> wrote a false `partnered` fact into pairStats. There was no way to recompute
> it — it had to be patched by hand (`scripts/fix-pairstats-2026-07-13.ts`).
>
> This is not hypothetical. Build `rebuildClubState()` before the club has
> real history worth protecting.
>
> UNTIL IT EXISTS: never delete a session that has games in it.
> Sticky note on the monitor.

### Trigger
Admin creates a session by accident. Or for the wrong date. Or the group cancels and he wants it gone.

### The architectural hole

```
sessions/{sid}/games/         ← lives IN the session. Deleted with it.
clubs/{cid}/meta/pairStats    ← lives in the CLUB. SURVIVES.
clubs/{cid}/players/{pid}.mu  ← lives in the CLUB. SURVIVES.
```

Delete the session → the games vanish → but **the ratings stay changed** and **`pairStats` still counts those pairings**.

The club's data is now permanently corrupt, and nothing warns you.

### The rule that should have been stated on day one

```
games      = SOURCE OF TRUTH.   Append-only. Never mutated.
pairStats  = DERIVED CACHE.     Must be rebuildable from games.
player.mu  = DERIVED CACHE.     Must be rebuildable by replaying from seed.
```

> **If derived data isn't rebuildable, every mistake is permanent.
> And there will be mistakes.**

### Expected — deletion is a rebuild, not a delete

| Case | Action |
|---|---|
| DRAFT, nobody checked in | Hard delete. Nothing derived exists yet. |
| LIVE, zero games recorded | Hard delete. |
| **Any games recorded** | `status = 'VOID'` — **never hard delete** — then **rebuild the club**. |

```
rebuildClubState(clubId):
  1. reset every player's mu/sigma to their SEED  (seedMu from lib/rating.ts)
  2. wipe pairStats
  3. load every game from every session where status != 'VOID',
     sorted by startedAt ascending
  4. replay: bumpCoAttendance per session,
             then updateRatings + pairStats per game
  5. write back
```

~940 games/year → **runs in about 2 seconds.** Don't optimise it. Don't make it clever.

The confirm dialog must show the cost:
> *"8 matches will be discarded. Ratings for 22 players will be recalculated. Takes a few seconds."*

### The bonus you don't know you need yet

Expose `rebuildClubState()` as an admin button: **"Recalculate everything."**

In six months you will want to change a weight, or you'll find a bug in the rating maths. **With rebuild:** fix the formula, press the button, done — the whole history recomputes correctly. **Without it:** you are locked forever into the decisions of week one, and every bug is permanent.

> **Two hours of code that buys you the right to be wrong.**

### Test
```
record 3 games → void the session → rebuild
→ every player's mu/sigma is byte-identical to their seed
→ pairStats is empty

two sessions, void only the second → rebuild
→ session one's effects survive intact
```

---

## UC-3 · Two people called Nam 🔴

### Trigger
A Vietnamese club of 55 people. There **will** be two people called Nam. This is not hypothetical.

### Expected
The **display name** must be disambiguable, by humans, at a glance: `Nam (Béo)`, `Nam A`, `Nam cao`. Not an internal ID — the name people actually read on screen and tap.

**Enforce at creation:** if the name already exists, require a distinguishing suffix before saving.

### Breaks naively
The wrong Nam gets checked in. The wrong Nam gets assigned. `pairStats` records a pairing that never happened. Silently.

### Test
Create two players named "Nam". The system must refuse, or force disambiguation.

---

## UC-4 · Somebody taps "won" three times 🔴

### Trigger
Slow wifi. Nothing appears to happen. They tap again. And again.

### Expected
All three requests succeed. **One** game is recorded. Nobody sees an error, and nobody learns they were second.

Idempotency key = `gameId`. If the game already has a `winner`, return `200 OK` and do nothing.

### Breaks naively
Three games recorded. Ratings updated three times. `gamesToday` +3. The queue is wrong, the ratings are wrong, and nobody knows why.

### Why this is coupled to the UI
This is **the same decision** as optimistic updates. If tapping doesn't give **instant** feedback, people will tap again — guaranteed. So either the UI responds instantly **and** the server is idempotent, or neither.

**You cannot pick one.**

### Test
```
recordResult(gameId: 'g47', winner: 'A')  ×3, in parallel
→ exactly one game recorded
→ gamesToday increased by exactly 1
→ all three calls return 200
```

---

## UC-5 · Two courts finish within three seconds 🔴

### Trigger
Court 1 ends at 20:14:03. Court 2 ends at 20:14:05. Both suggestions include Cuong.

### Expected
Whoever taps **[Take court]** first gets Cuong. The other gets a `409`, silently refetches, and shows a **new suggestion**.

**The user must never see an error.** This is a normal event, not an exception.

### Breaks naively
Cuong is assigned to two courts at once. He plays neither. Four people stand around. Someone notices ten minutes later, and both matches' data is wrong.

### Why the client still proposes the four
Because the user can press [Swap] and pick their own. The client **proposes**; the server **re-validates inside the transaction** and approves or rejects. See `assignCourt()` in `lib/firestore.ts`.

### Test
```
Promise.allSettled([
  assignCourt(court 0, [An, Binh, Cuong, Dung]),
  assignCourt(court 1, [An, Binh, Em, Phong]),
])
→ exactly one fulfilled
→ exactly one rejected with ConflictError
→ no player is PLAYING on two courts
```

---

## UC-6 · Somebody taps the wrong winner 🔴

### Trigger
Sweaty fingers. 56px buttons. Wrong side.

### Expected
**Undo bar. 60 seconds. Anyone can press it.** Ratings roll back. `gamesToday` rolls back. `pairStats` rolls back.

### The trap that will get you

**TrueSkill has no inverse function.** You cannot derive the old `mu` from the new one. There is no arithmetic that undoes it.

So you must write a `before` snapshot **at record time**:

```jsonc
"before": {
  "ratings":    [ {"id":"p1","mu":52.1,"sigma":6.2}, ... ],   // 4 players
  "pairs":      [ {"key":"p1|p2","partnered":3}, ... ],       // 6 pairs
  "attendance": [ {"id":"p1","gamesToday":2,"freeAt":...} ]
}
```

A few hundred bytes per match. Cheap.

**If you forget:** undo rolls back the game count but **not the rating**. It will *look* like it worked. You'll find out in month three, when the leaderboard is wrong and there's no way to fix it.

### Test
```
snapshot = deepCopy(clubState)
recordResult(...)
undo(auditLogId)

→ clubState is byte-identical to snapshot
→ check mu, sigma, gamesToday, freeAt, AND pairStats
```

---

# PART 3 — The loud failures 🟠

Somebody shouts. Fixable on the spot. Still needs handling.

---

## UC-7 · Nobody records a result for four minutes 🟠

### Trigger
Court 2 finished. The four players are drinking water and chatting. Nobody tapped.

### The hard truth
The app **cannot know.** It has no camera. It hears no shuttlecock. It knows only what a human tells it.

> **This is the single largest risk in the entire project, and it is not a technical problem.**

### The insight: separate two facts

| Fact | Who knows it | Urgency |
|---|---|---|
| *"Is court 2 free?"* | **Everybody.** You can see it. | **Urgent** — the queue is a lie until this is known |
| *"Who won?"* | Only the four who played | **Not urgent** — needed for ratings, not for the queue |

**Consequence: the app must NEVER block assigning the next match just because nobody recorded a winner.**

Allow `winner: null`. Fill it in later. Or never.

### Expected
When a court's clock passes ~25 minutes, surface a prompt on **every** phone:

> **Is court 2 done?**   `Yes` · `Not yet`

One tap. No need to know who won.

### Who actually taps?
Not the admin — he's playing. **The four people who are next up on that court.** They're waiting. They want that court. They're already staring at it.

> **The person who benefits is the person who taps.**
> This is the only kind of mechanism that survives contact with reality.

### Measure this on the day, manually, with a watch

> **Recording latency** = tap time − actual finish time
>
> - **< 1 min** → the app is in sync with reality
> - **3–5 min** → the app lives in the past, the queue is a lie, people stop trusting it
> - **Nobody taps** → **the app does not exist.** Fix this before anything else.

### Test
```
create a game, leave winner = null
assignCourt() on that same court
→ must succeed
```

---

## UC-8 · Only 17 people show up (3 courts booked) 🟠

### Trigger
Five people cancel Friday night. Nobody rebooked the courts.

### The paradox nobody expects

```
pool = present − (courts × 4)
     = 17 − 12
     = 5
```

The algorithm's window is 8. The pool is 5. **The window has nothing to choose from.** It degenerates into pure FIFO — the exact behaviour that manufactures cliques.

> ### TOO FEW PEOPLE BREAKS THE APP.
> You need people sitting out to have something to mix.

### Safe floor: `people ≥ courts × 4 + 8`

| Courts | Minimum |
|---|---|
| 2 | 16 |
| 3 | **20** |
| 4 | 24 |

### Expected
Warn at setup **and** at check-in, in plain language:

> *"17 people, 3 courts. Only 5 waiting at a time — the app has almost no choice in who to pair. Consider 2 courts."*

**Don't block.** Show the number. Let them decide.

### Test
`suggestMatch()` with a pool of 5 must still return a valid match, not crash. But the app should have warned already.

---

## UC-9 · The algorithm suggests something stupid 🟠

### Trigger
Week one. Ratings are noise. It pairs the two strongest against the two weakest. Somebody laughs.

### Expected — two escape hatches, in order

**1. [Swap]** — always visible, never buried in a menu. Tap it, pick four by hand, move on.
Log `accepted: false`. **This is the project's real score.**

**2. [Manual teams]** — switches the whole session to RECORD mode. The algorithm stops. The evening carries on. **The data is still collected.**

> **Without that second button, one bad suggestion wrecks the session for 22 people and you will never dare try again.**
>
> **It matters more than the algorithm.**

### The paradox worth knowing
Precisely *because* people can see the [Swap] button, they rarely press it. A visible escape hatch reduces the desire to escape.

---

## UC-10 · Wifi dies mid-session 🟠

### Trigger
Hall wifi, 11:15am. Not *if*. **When.**

### Expected

| Duration | Behaviour |
|---|---|
| **< 15s** | Optimistic update stands. Retry silently. **Say nothing.** |
| **> 15s** | Red dot. **Disable the write buttons.** Say: *"Offline. What you're seeing is stale."* |
| **Reconnect** | **Refetch the whole state.** Don't merge deltas — you have no idea what changed while you were blind. |

### Breaks naively
Somebody taps into a dead app for two minutes, believes they recorded three results, and **none** of them landed. The queue silently diverges from reality.

> **A red dot that says nothing is worse than no dot at all.**

### Test
Kill the network. Tap a result. Restore the network. Exactly one game recorded, and the UI was honest the entire time.

---

## UC-11 · Somebody sits out for 40 minutes 🟠

### Trigger
Son isn't very good. The algorithm keeps finding reasons to pick other people. He is always *in* the window and never *chosen from* it.

### Expected
The starvation constraint fires at 25 minutes. Son is **forced** into the next match, overriding every other term.

And the reason sentence **says so**:

> *"Son has waited 25 minutes — absolute priority."*

**Why the sentence matters:** the other three players are about to wonder why this match looks odd. Tell them before they ask.

### Breaks naively
One person quietly sits out the whole session. You find out when he stops coming — permanently.

### Test
Already in `engine.test.ts`: a player waiting > 25 min appears in 100/100 suggestions.

---

## UC-12 · The session never ends 🟠

### Trigger
12pm. Everyone goes home. Nobody taps anything.

Next Saturday, the session is still `LIVE`. `getActiveSession()` returns last week's. The app shows a week-old queue.

### Expected — two layers, because one isn't enough

1. **[End session]** button in the footer (recessed — nobody will remember to press it).
2. **Automatic:** any `LIVE` session dated before today is treated as `DONE`. **Check on read.** No cron job, no scheduled function.

**DEFERRED, not built:** in-progress matches at cutoff → `status: VOID`, no
rating update, no `pairStats` update. What's actually shipped: `endSession()`
leaves in-progress courts/games exactly as they are, inside a session neither
`/` nor `/admin` surface afterward — the admin sees how many courts are still
mid-match before confirming (`app/admin/sessions/page.tsx`) and makes an
informed call. No auto-void, no rating cleanup. Build the VOID path if this
ever actually bites someone; until then, the honest, smaller version is what
exists.

### Test
A `LIVE` session dated yesterday. Open the app today. It must not resurrect.

---

# PART 4 — The friction 🟡

Works, but annoys. Erodes trust one small cut at a time.

---

## UC-13 · Somebody leaves early 🟡

**Trigger** Minh played 2 games. It's 11:20. He's going home.

**Expected** Anyone taps Minh → `LEFT`. He vanishes from the queue. His `gamesToday` is preserved — that data is still true.

**Breaks naively** The app keeps offering Minh a court. Four people wait for a man who's in his car.

---

## UC-14 · Somebody goes to the toilet 🟡

**Trigger** Lan is 2nd in the queue. She's in the toilet. Court 3 frees up.

**Expected** `PAUSED`. She stays in the roster, keeps her `gamesToday`, and is skipped for selection. When she returns → `AVAILABLE`, and **her wait clock is not reset** — she didn't choose to sit out.

**The design question you must answer**
Does she pause herself? **She won't remember. She's in the toilet.**

**So: anyone can pause anyone.** One tap on their name in the queue. No permission, no confirmation.

**Breaks naively** The app assigns her. Four people wait three minutes. Someone shouts. Someone swaps her out by hand. Now the queue is a lie.

---

## UC-15 · Someone brings a guest 🟡

**Trigger** Tuan turns up with a friend. Nobody told the admin.

**Expected** Add a guest in **under 10 seconds**:
- name
- **"Who in the club plays at their level?"** ← a far better seed than asking them to self-rate

Straight into the queue.

**Also show the cost, without blocking:**
> *"3 guests → everyone drops from 3.5 to 3.0 games."*

Don't block. Show the number. Let the group decide.

**Never:** guests on the leaderboard. Somebody who played 3 games and vanished forever, sitting 5th on the table, destroys the table's credibility.

**The rating is self-protecting** — a guest's large `sigma` automatically dampens the update applied to members. No extra code needed. **This is why TrueSkill, not Elo.**

**Breaks naively** There's no way to add them → someone writes it on paper → **the whole session's data is corrupt.**

---

## UC-16 · Court count changes mid-session 🟡

**Trigger** 3 courts booked. Another group is squatting on court 2. Or the reverse — court 4 is free, grab it.

**Expected** `courtCount` is editable mid-session.
- **Remove a court that's in play** → confirm *"Void this match?"* → players return to `AVAILABLE`.
- **Add a court** → it appears, empty, ready.

**Breaks naively** `courtCount` is frozen at creation and you must rebuild the entire session while standing in a sports hall.

---

## UC-17 · A club member turns up who isn't on the roster 🟡

**Trigger** Not a guest — a member. The admin forgot to pick him, or he's covering a cancellation.

**Expected** `/checkin` has **"+ Add from club"** → search the 55 → check in. Done without leaving the screen.

**Breaks naively** Walk off court → `/admin/session/new` → edit roster → walk back. **Four screens for a three-second job.**

---

## UC-18 · Admin forgot to set up the session 🟡

**Trigger** Saturday 9:58am. Nothing exists in the app.

**Expected** `/` shows *"No session yet"* and **one** obvious action. Creating a session from scratch, at the hall, must take **under 60 seconds**: courts, headcount, start. The roster fills itself via check-in.

**Breaks naively** A dead end. Data-less silence and no next action.

> **This is exactly where people get lost.
> Every screen must answer: "done — now where?"**

---

## UC-19 · Wrong name picked on first open 🟡

**Trigger** Fat fingers. The app now thinks you're Tuan.

**Expected** Changeable in one tap, from the footer: *"You are Minh · change"*. No confirmation. No password.

---

## UC-20 · Somebody's phone dies 🟡

**Trigger** The person who's been recording results has 3% battery.

**Expected** Irrelevant. Anyone with the code picks up where they left off. **There is no session owner, no lock, no "recording device."**

**This is a design test, not a code test.** If any part of the app assumes one specific device, it is wrong — and it will fail in exactly this way.

---

## UC-21 · When does the score field appear? 🟡

The score is optional — but *when* it appears determines whether anyone ever enters it.

```
tap "Tuan & Lan won"
   → court empties IMMEDIATELY (optimistic)
   → the undo bar rises
   → INSIDE that bar:  "21 – [__]"   ← small field, dismissible
   → type nothing → it disappears with the bar after 60s
```

**It must never block the path.**

If you require the score before the tap counts, you'll get ~60% compliance, and the data will be **biased toward the matches people cared about** — which is exactly the data you cannot use.

**Test** Record a result without touching the score field. Must succeed, `scoreLoser: null`.

---

## UC-22 · A spectator opens the link 🟡

**Trigger** Someone's wife opens the link from home to see when he'll be back.

**Expected** The whole session is readable **without a code**. Courts, queue, who's playing. No login, no prompt, no *"enter code to view."*

**Why:** this is how the app spreads through the group.

> **An app you must ask permission to look at is an app nobody looks at —
> and an app nobody looks at is an app nobody uses.**

**Never readable without a code:** ratings, pair history, the audit log.

---

## UC-23 · The app simply isn't used this week 🟡

**Trigger** The group picks teams by hand for the whole session. Nobody opens the app.

**Expected** **Nothing breaks.** Next week it works normally. No "incomplete session" state to clean up. No error. No nag notification.

**Design implication:** from the group's point of view, the app is **stateless between sessions**. It sits quietly and waits to be useful.

At 1 hour a week, **being ignored is the app's normal state**, not a failure.

---

# PART 5 — Two features that keep getting cut, and shouldn't be

## F-1 · The mixing score

> **"You've played with 14 of 21 people. Never with: Hai, Lan, Nam."**

**This is the success metric of the entire project**, and it gets cut every single time the scope is trimmed.

Two reasons to build it:

**1. It turns your goal into a game.** People will *want* to fill the list. You get the outcome through intrinsic motivation rather than coercion — which matters enormously, because the app only assigns ~25% of matches.

**2. Without it you cannot tell whether the app works.** If the group's mixing number doesn't rise, the app has failed — no matter how elegant the algorithm.

> **Most people who build this kind of app never measure the thing they built it for.**

Half a day of work. **Correct from day one — needs no rating, no convergence, no waiting.**

---

## F-2 · The post-session summary, pasted into the group chat

```
Badminton · Sat 19 Jul · 19 people, 24 matches

Longest streak:      Tuan (5)
Most mixed:          Lan — 11 different partners
First-time pairings: An–Hai, Binh–Nam, Cuong–Thao
```

The app sleeps six days a week. **This message is the only thing reminding the group it exists.**

At 1 hour a week, this isn't decoration — it's the **retention channel**. An app that only lives for two hours in a sports hall gets forgotten.

---

# PART 6 — Empty states

**Every screen, with no data, must show one obvious next action. Never a dead end.**

| Screen | Empty state | The one action |
|---|---|---|
| `/` — no session | *"No session yet"* | quiet link → `/admin` |
| `/` — DRAFT exists | *"Next session: Sat 19 Jul · 22 players"* | **[Start session]** |
| `/` — LIVE, nobody checked in | *"Nobody's checked in yet"* | **[Check people in]** ← the hero of the screen |
| `/` — checked in, no games | *"Ready. Pick teams and record the first match."* | the mode switch is prominent |
| `/` — fewer than 4 available | *"Waiting for a court to free up"* | nothing. This is fine. |
| `/checkin` — roster empty | *"No roster for this session"* | → `/admin/session/new` |
| `/admin/players` — no players | *"No players yet"* | **[Add player]** |
| `/admin` — no session | the "New session" card is the hero | |

> **A screen with no data and no next action is a bug, not a state.**

---

# PART 7 — What to test, and where

```
lib/            ← unit, pure, no mocks, deterministic (rng injected).
                  20 tests. ALREADY PASSING. Don't break them.
                  Covers: UC-11 (starvation), UC-14 (paused excluded),
                          UC-8 (small pool doesn't crash)

lib/firestore   ← integration, Firestore emulator. WRITE THESE:

                  UC-1   swap on an in-play court → the RIGHT four are recorded
                  UC-2   void a session → rebuild → byte-identical to seed
                  UC-4   three identical results → exactly one game
                  UC-5   two concurrent assigns → exactly one wins
                  UC-6   record → undo → mu/sigma/pairStats byte-identical
                  UC-7   record with winner: null → next assign still succeeds
                  UC-12  a LIVE session dated yesterday → treated as DONE
                  UC-21  record with no score → succeeds, scoreLoser: null

app/            ← don't unit-test. Changes constantly, low value.
                  Instead: walk PART 8 by hand. Once. Twenty minutes.
```

---

# PART 8 — Dry run, alone, the night before

**The highest-value twenty minutes in the entire project.**

Every box that fails here is a box that would have failed **in front of 22 people**.

### Setup
- [ ] Create a session for a **future** date. Confirm it shows as DRAFT, not LIVE.
- [ ] Open `/`. Confirm it shows the DRAFT with a [Start session] button.
- [ ] Start it. Check in 22 fake people.
- [ ] Confirm the empty state made [Check people in] the obvious action.

### Recording
- [ ] RECORD mode: record 9 matches by hand. Confirm `gamesToday` is right for everyone.
- [ ] Switch to ASSIGN **mid-session**. Confirm nothing resets.
- [ ] Take a suggestion. Then **reject** one — confirm `accepted: false` is logged.
- [ ] Record a result **without** entering a score. Must succeed.

### The silent killers
- [ ] **Swap a player on a court that's already in play.** Record. Confirm the **right four** are logged, and the swapped-out player got **no** game credit. ← UC-1
- [ ] Tap a result **three times fast**. Confirm exactly one game. ← UC-4
- [ ] **Undo it.** Confirm ratings, `gamesToday`, and `pairStats` all rolled back. ← UC-6
- [ ] Create a junk session, record 2 games, **void it**, rebuild. Confirm every rating is back to its seed. ← UC-2
- [ ] Try to create two players named "Nam". Confirm it's refused. ← UC-3

### The mess
- [ ] Mark someone `PAUSED`. Confirm they're skipped. Un-pause them.
- [ ] Mark someone `LEFT`. Confirm they're gone from the queue.
- [ ] Add a guest mid-session. Confirm the games-per-person warning appears.
- [ ] Add a **club member** who wasn't on the roster, from `/checkin`.
- [ ] Change court count mid-session — up, then down.
- [ ] Turn off wifi. Tap things. Turn it back on. **Confirm the UI was honest the whole time.**
- [ ] Press **[Manual teams]**. Confirm the session survives and data still flows.
- [ ] **[End session]**. Reopen tomorrow. Confirm it doesn't resurrect.

### The outside view
- [ ] Open the link in an **incognito window, no code**. Confirm you can read but not write.
- [ ] Confirm ratings are **not** visible to a spectator.

---

# PART 9 — The one number to measure on the day

Not coverage. Not Brier score. Not uptime. Not test coverage.

> ## How many times did anyone press [Swap]?
>
> **< 30%** → the algorithm is acceptable
> **> 60%** → something's wrong, and the audit log will tell you exactly where

This is the real score. It's the one number **no simulation can hand you**, and the only one that measures whether 22 human beings accept what the app tells them to do.

---

# PART 10 — The risks that aren't in this file

The simulation proves the algorithm **can** reach 100% coverage. It proves **nothing** about whether anyone will use it.

| Risk | Can you test it? |
|---|---|
| **Nobody records results** | No. If this happens, the app does not exist. Measure recording latency. |
| **"Nah, I'll just play with Tuan"** | No. [Swap] + [Manual teams] are the only defence. |
| **The scorekeeper finds the app more annoying than paper** | No. **Go ask them.** |
| **The group doesn't actually think cliquiness is a problem** | No. **This is the number one risk in the project.** |

Every one of these is a conversation, not a commit.

**Have those conversations before the trial session — not after it fails.**
