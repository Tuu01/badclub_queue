# Decisions — a reader's guide to the testing and the interface

This document explains **why** this codebase is built the way it is: what
technique each piece uses, what that technique is actually called, where it
lives in the repo, and what problem it solves.

It exists because knowing *that* something works is not the same as being able
to explain *why it was done that way*. Everything below is traceable to code in
this repository — read the file alongside the section.

---

## Part 1 — Testing

### 1.1 The idea everything else rests on: purity and seams

Three files are marked "do not modify": `lib/types.ts`, `lib/rating.ts`,
`lib/matchmaking.ts`. They share one property — they are **pure**.

A **pure function** is one where the output depends *only* on the arguments you
pass in, and which changes nothing outside itself. Same input, same output,
every time, forever.

Most code that decides "who plays next" would naturally reach for the clock and
a random number:

```ts
// The version that CANNOT be tested
function suggestMatch(players) {
  const now = Date.now();               // ← different on every run
  const shuffled = players.sort(() => Math.random() - 0.5);  // ← different every run
  ...
}
```

You cannot write an assertion against that. Run it twice, get two answers. So
instead, both are passed *in*:

```ts
// lib/matchmaking.ts — the real signature
suggestMatch({ now, players, attendance, pairStats, config, busy, rng })
```

`now` is a number you supply. `rng` is a function you supply. In production the
app passes `Date.now()` and `Math.random`. In a test it passes `NOW = 1_000_000_000`
and `rng: () => 0.5`, and the function becomes completely predictable.

**The technique is called dependency injection**, and the general principle is
**separating decisions from effects** — the logic that *decides* has no ability
to *do* anything (no database, no network, no clock). Effects live in
`lib/firestore.ts`, one layer out.

The places where you can substitute a fake for the real thing are called
**seams**. `now` and `rng` are seams. The `Db` interface (§1.6) is a seam.

> **In an interview:** "The matchmaking engine is pure — time and randomness are
> injected parameters, not ambient calls. That's what makes it testable at all,
> and it's why the same function can be driven 200 times in a loop with a
> controlled RNG to assert on a distribution."

---

### 1.2 Why there is no Jest or Vitest

`tests/engine.test.ts` opens with this:

```ts
let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
```

That is the entire test framework — 5 lines. Tests run with `tsx`, which
executes TypeScript directly.

**The trade-off, honestly:** a real framework gives you parallelism, watch mode,
snapshot testing, coverage reports, mocking utilities, and `describe`/`it`
nesting that IDEs understand. Those are genuine benefits and on a team project
you would take them.

What you get instead: zero additional dependencies, a suite that starts in
milliseconds, and no configuration file to maintain. For a solo project with a
small pure core, that's a defensible call — and being able to *articulate the
trade-off* is worth more in an interview than either choice by itself.

> **In an interview:** don't claim hand-rolling is better. Say: "I traded
> tooling for zero config on a small pure core. On a team I'd use Vitest for
> watch mode and coverage — the tests themselves would barely change, because
> they're just functions and assertions."

---

### 1.3 Test names are written as specifications

Compare these two names for the same test:

```
✗  "buildQueue sorts correctly"
✓  "games played beats wait time (Alex with 1 game ranks above Casey
    with 2, even though Casey waited longer)"
```

The second is the one in the repo. When it fails, the failure output *is* the
bug report — you don't open the test to find out what broke.

More importantly it records a **product decision**. Sorting by games played
rather than wait time is the thing club members actually argue about; the test
name is where that decision is written down. The suite doubles as documentation
of how the club works.

**The technique is behaviour-driven naming.** The rule of thumb: a test name
should describe the behaviour and be understandable by someone who has not read
the implementation.

---

### 1.4 Fixture builders

Every test needs 22 players and some attendance records. Writing those objects
by hand in each test would be unreadable, so there are two small factories:

```ts
function makePlayers(): Map<PlayerId, ClubPlayer>   // 22 players, divisions, seeds
function att(id, games, waitMin, status = 'AVAILABLE'): Attendance
```

Now a whole scenario reads as prose:

```ts
['Casey', att('Casey', 2, 22)],   // waited LONGEST but 2 games
['Alex',  att('Alex',  1, 19)],
['Kai',   att('Kai',   4,  0)],   // just came off a court
```

**The technique is the Object Mother / test data builder pattern.** The point is
that each test states only what is *different* about its scenario; everything
else is a shared default. When a test is 90% noise, nobody reads it, and
unreadable tests get deleted the first time they fail.

---

### 1.5 Asserting on distributions, not single runs

This one is the most unusual technique in the repo, and the most interesting to
talk about.

The matchmaker is deliberately **non-deterministic** — it picks randomly among
the top N candidate matches so the same four people don't get the same court
every week. So "call it once and check the answer" is meaningless. The
behaviour you actually care about is statistical.

So the test calls it 200 times and asserts on the *count*:

```ts
let alexBlakeTogether = 0;
for (let t = 0; t < 200; t++) {
  const s = suggestMatch({ ..., rng: Math.random })!;
  if (sameTeam) alexBlakeTogether++;
}
check(`a heavily-repeated pair is NOT re-paired (${alexBlakeTogether}/200)`,
      alexBlakeTogether === 0);
```

Note what's asserted: **exactly 0 out of 200**, not "fewer than 20". The
same pattern appears inverted for the starvation rule:

```ts
check(`anyone waiting >25 min is ALWAYS forced in (${included}/100)`,
      included === 100);
```

**Exactly 0 and exactly 100 are the right assertions here**, because these are
*hard constraints* in the algorithm, not tendencies. A threshold like `< 20`
would pass even if the constraint were subtly broken. Asserting the absolute
makes the test sensitive to exactly the bug it's meant to catch.

This is close to **property-based testing** — instead of checking one
input→output example, you assert a property that must hold across many
generated runs ("a stale pair is never re-paired"). Real property-based
libraries (fast-check, Hypothesis) generate the inputs for you and shrink
failures to a minimal case; this is the hand-rolled version of the same idea.

> **In an interview:** "The engine is intentionally random, so single-run
> assertions would be meaningless. I loop 200 times and assert on the
> distribution — and because these are hard constraints rather than tendencies,
> I assert exactly 0/200 and exactly 100/100 rather than a threshold."

---

### 1.6 The in-memory fake — the most valuable pattern here

The problem: `lib/firestore.ts` contains 27 functions of real business logic
(assigning courts, recording results, rebuilding ratings). Testing them against
real Firestore needs credentials, a network, and cleanup, and it is slow. But
**re-implementing** those functions in a test would be worthless — the copy
could drift from the original and you'd be testing the copy.

The solution: don't fake the *logic*, fake the *storage underneath it*.

`lib/repo.ts` defines a minimal interface — just the slice of Firestore the app
actually uses (`doc`, `collection`, `get`, `set`, `runTransaction`, …). Two
implementations satisfy it:

| Implementation | What it is | Used by |
|---|---|---|
| `lib/repo-fs.ts` | Real `firebase-admin` Firestore | Production |
| `lib/repo-mem.ts` | Plain JavaScript objects, zero I/O | Tests |

Every data function takes `db: Db` as its first argument and runs **unchanged**
against either one. `tests/rebuild.test.ts` therefore exercises the *real*
`rebuildClubState`, with no credentials and no network.

**The technique has several names** — you'll hear all of them:

- **Ports and adapters** (also *hexagonal architecture*): `Db` is the port, the
  two files are adapters.
- **Dependency inversion** (the D in SOLID): the business logic depends on an
  interface it owns, not on Firestore.
- A **fake** in test-double terminology: a working implementation with a
  shortcut, as distinct from a *mock* (records calls) or a *stub* (returns
  canned values).

The comment in `repo.ts` states the reasoning precisely, and it is the single
best line to quote in an interview:

> *"An in-memory copy of the functions could silently drift and give false
> confidence; a mock of the storage primitive cannot, because the code above it
> is identical in both modes."*

---

### 1.7 The shape of the suite

The tests fall into three layers, which is the standard **test pyramid**:

| Layer | Files | Speed | Needs | Count |
|---|---|---|---|---|
| Pure unit | `engine.test.ts` | instant | nothing | 38 |
| Fake-backed integration | `repo-mem`, `rebuild`, `tournament`, `tournament-live` | fast | nothing | 83 |
| Real integration | `firestore-uc5.test.ts` | slow | credentials + network | 1 scenario |

121 tests run offline with `npm run test:safe`. Exactly one test needs the real
world — and §1.8 explains why that one is worth its cost.

---

### 1.8 Deciding what *not* to test

This is judgement, and it is the part most junior candidates never demonstrate.

`tests/firestore-uc5.test.ts` carries a long comment explaining why a Firestore
**emulator** suite was deliberately *not* built: it needs `firebase-tools` and a
Java runtime, and the thing being tested — optimistic-concurrency retry on a
single document — is Firestore's own guarantee, not application logic. An
emulator wouldn't exercise a meaningfully different code path.

So one scenario runs against the real database with a throwaway session ID,
created and deleted in the same run.

The general principle is **risk-based testing**: spend test effort where
`likelihood × cost-of-failure` is highest. `USECASES.md` names the target
directly — the double-booking race is *"the only thing in the app that can
break in a way I can't see, can't reproduce, and can't fix on Saturday
morning."*

Two things make this a strong answer rather than an excuse:

1. The reasoning is **written down**, so the next person can re-evaluate the
   trade rather than find an unexplained gap.
2. It is **honest about its own limits** — the comment states plainly that the
   test isn't hermetic and needs network and credentials.

> **In an interview:** "I tested the one failure that's unrecoverable in
> production and documented why I skipped the emulator suite. Not every gap is
> an oversight — some are a priced trade-off, and the difference is whether you
> wrote the reasoning down."

*(Since then, emulator support has been added — `scripts/seed-demo.cjs` seeds a
fake club into the local emulator. The original trade-off stands as the record
of how the decision was made at the time.)*

---

### 1.9 How you test a race condition

A race condition is the hardest thing to test because the bug only appears when
two things happen at nearly the same instant. You can't reproduce that by
calling a function twice in sequence.

The technique: fire both operations **without awaiting the first**, then inspect
how they settled.

```ts
const settled = await Promise.allSettled([
  assignCourt(db, SID, { courtIdx: 0, four: [An, Binh, Cuong, Dung], ... }),
  assignCourt(db, SID, { courtIdx: 1, four: [An, Binh, Em, Phong],  ... }),
]);
```

Both want An and Binh. `Promise.allSettled` waits for both and reports each
outcome rather than rejecting at the first failure — which is exactly what you
need, because **one of them is supposed to fail**.

The assertions then check the invariants that must survive any interleaving:

```
✓ exactly one fulfilled
✓ exactly one rejected
✓ the rejection is a ConflictError (not some other failure)
✓ An is on exactly one court, not two
✓ the losing court's other two players are untouched (still AVAILABLE)
```

That last one is the sharp assertion. It's not enough that the losing
transaction failed — it must have failed **atomically**, leaving Em and Phong
free rather than half-locked by a partial write. That is the actual definition
of a transaction, tested directly.

> **In an interview:** this is your strongest story. "Two phones finish their
> games seconds apart and both grab the same player. The client proposes, the
> server approves inside a Firestore transaction; the losing transaction re-reads
> inside the same document, sees the player taken, and throws. I test it by
> firing both writes concurrently with `Promise.allSettled` and asserting that
> exactly one wins and the loser's other players are left untouched."

---

### 1.10 Vocabulary

Terms for the things you already built:

| Term | What it means here |
|---|---|
| **Pure function** | `rating.ts` / `matchmaking.ts` — output depends only on inputs |
| **Dependency injection** | `now` and `rng` passed in, never called ambiently |
| **Seam** | A place a fake can be substituted: `rng`, `now`, `Db` |
| **Test double** | Umbrella term for fakes, mocks, stubs, spies |
| **Fake** | `repo-mem.ts` — a real working implementation, simplified |
| **Ports and adapters** | `Db` is the port; `repo-fs` / `repo-mem` are adapters |
| **Dependency inversion** | Logic depends on an interface it owns, not on Firestore |
| **Property-based testing** | Asserting a property across many runs (§1.5) |
| **Test pyramid** | Many fast unit tests, few slow integration tests |
| **Risk-based testing** | Effort goes where failure is most costly |
| **Idempotent** | Safe to run twice — `importTournament` keys on (name, date) |
| **Optimistic concurrency** | Assume no conflict; detect and retry if there was one |

---

## Part 2 — Interface and experience

### 2.1 Design starts from the context, not the screen

The first section of `UI.md` is not a colour palette. It is a table of physical
facts about the moment of use, each with a consequence:

| Reality | Consequence |
|---|---|
| Sweaty hands, out of breath | Touch targets ≥ 56px. No small buttons. Ever. |
| One-handed, standing up | Every action in thumb reach (lower half) |
| Glanced at for 3 seconds | The answer must be above the fold |
| Bright hall, overhead glare | High contrast, dark ground |
| Looking at a real court | The court card should look like the court |
| 11 of 22 are sitting out | The default screen serves the **waiting** |

This is the correct order of operations: **context → constraint → decision**. A
decision derived from a constraint can be defended; a decision made because it
looked nice cannot.

It also produces non-obvious answers. "The default screen serves the waiting,
not the playing" inverts what most sports apps do — and it follows from
counting: at any moment 11 of 22 people are holding a phone, and the other 11
are on court and not looking.

> **In an interview**, when asked to justify a design choice, always answer in
> this shape: *"Because [fact about the user's situation], therefore
> [decision]."* Never *"because it looks cleaner."*

---

### 2.2 Colour as signal, not decoration

The rule from `UI.md`:

> `--signal` appears at most **once** on screen. If you see two red things, the
> design has failed.

The palette is almost monochrome — dark court green, white lines — with exactly
one hot colour (`#FF4D2E`), used *only* to mean "this concerns you": your row in
the queue, and the border of a court you're on.

The reasoning is about **information theory**, not taste. Most sports apps use
green for wins, red for losses, amber for waiting — and once every colour means
something, no colour means anything, because the eye has nothing to lock onto.
Constraining to one signal colour keeps it genuinely attention-grabbing.

Two consequences follow, both written as rules:

- **No colour for win/loss.** A match result is not an emergency — use words.
- **Hierarchy comes from lines, not fills.** To separate two regions, use one
  1px hairline, not a grey card. (Also why there are no gradients, shadows, or
  glassmorphism: a badminton court is a flat plane, so the app is too.)

**The general principle is signal-to-noise budgeting**, and it generalises past
colour: every emphasis mechanism — bold, size, motion, colour — is a currency
you can spend into worthlessness.

---

### 2.3 Information architecture from three questions

`UI.md` asserts that someone opens this app to answer exactly one of three
questions:

1. *"When do I play?"* — 11 people, all session long
2. *"Who am I with, which court?"* — the moment they're called up
3. *"Court's done, record it"* — the four who just finished

The layout then answers them **top to bottom in that order**, on one screen.

> If answering any of these requires a scroll, a tap, or a hunt — the design has
> failed.

Hence: no nav bar, no tabs, no hamburger. Navigation exists to reach many
destinations; if there's only one screen worth showing during a session, adding
navigation adds a decision without adding a destination.

The frequency ordering matters: the biggest type in the entire app is the
waiting countdown (`44px` Archivo), because question 1 is asked by the most
people for the longest time. **Type size follows question frequency.**

*(The app does have other routes — `/board`, `/me`, `/history`. The discipline
is that they're for the sofa at home, not the hall. "There is no second
screen" is about the live session, not the whole product.)*

---

### 2.4 Recognition over reading

The signature element: each court is drawn as an actual badminton court in
hairlines — doubles sidelines, service lines, a dashed net down the middle —
with the four names placed in their real halves. It's inline SVG with the true
proportions (`app/CourtDiagram.tsx`).

> The user looks up at the court, then down at the phone. Same shape. They don't
> *read* — they *recognise*.

Recognition is roughly an order of magnitude faster than reading, and it
survives conditions where reading fails: glare, motion, three-second glances,
being out of breath. (In HCI this is **recognition over recall**, and the map
between the real object and its representation is a **spatial mapping**.)

The discipline is in the next line of `UI.md`:

> **Why it isn't decoration:** the lines encode real information (which side,
> which team). If it were just a pretty drawing, delete it.

That is the test to apply to any illustration in a UI: *does it carry
information?* The court lines do — they tell you which pair is which. The
`fit()` function in the same file handles the failure case honestly: a long name
compresses via SVG `textLength` rather than overflowing the court boundary.

---

### 2.5 Touch targets, thumb reach, and Fitts's law

Every interactive element is at least **56px** tall; the spacing scale is
`4 · 8 · 12 · 16 · 24 · 32` and horizontal padding is always 16px.

For reference, Apple's HIG recommends 44pt and Material Design 48dp. 56px is
above both — deliberately, because the user is out of breath with sweaty hands.
**Know the standard, then state why you departed from it.**

**Fitts's law** says the time to hit a target grows with distance and shrinks
with target size. Both levers are pulled: targets are large, and actions live in
the lower half of the screen where a thumb naturally rests on a phone held
one-handed. Status information — which you only read — sits up top.

The result buttons show a related principle:

> **Name the team, not "Team A".** Whoever taps shouldn't have to work out which
> side A was.

The button says `Tom Bailey & Daniel Hughes won`. Forcing a translation step
between the label and the world is where mis-taps come from — and a mis-tap here
writes a wrong result into everyone's rating.

---

### 2.6 Typography that holds still

Two decisions worth being able to explain.

**`font-variant-numeric: tabular-nums` is mandatory on anything that changes.**
In most fonts a `1` is narrower than a `0`, so a live clock reflows every
second and the eye has to re-read it. Tabular figures give every digit the same
width, so the number changes without moving. It's one CSS line (the `.tabular`
class in `app/globals.css`) and it's the difference between a clock that reads
cleanly and one that jitters.

**Archivo's variable `wdth` axis.** Archivo is a variable font — a single file
containing a continuous range rather than separate weights. Here the width axis
is pushed to 110–120% for names and the countdown, which gives signage /
scoreboard energy.

`UI.md` guards it explicitly:

> It will be the first thing someone deletes to save 20KB. Don't.

That is a good habit: when a choice is load-bearing but looks like fat, say so
next to it, or someone will optimise it away.

---

### 2.7 Explainability is what makes an algorithm acceptable

Every suggested match carries one sentence of reasoning, generated by `explain()`
in `lib/matchmaking.ts`:

> *Emily Hart & Ryan Mitchell have never partnered. Tom Bailey has waited
> longest (14 min).*

`UI.md` states the stakes:

> Without that sentence the app is a dictator. With it, the app is a referee.
> People argue with a referee — but people **accept** one.

This is the UX of automated decisions, and it generalises to anything
algorithmic: a system that allocates something scarce (court time, shifts,
seats) needs to show its reasoning or people route around it. The app runs one
hour a week — it has no runway to gradually earn trust.

Two supporting decisions:

- **`Swap` is always visible, never buried.** The paradox in the docs: *because*
  people can see the Swap button, they rarely press it. Visible escape hatches
  reduce the need to use them, because the user knows they aren't trapped.
- **Every Swap logs `accepted: false`.** The docs call this *"the project's real
  score"* — the app measures its own rejection rate. Instrumenting your own
  failure is a strong instinct to show.

There's a matching restraint on the other side. The engine can compute a win
probability, but it stays hidden behind `canShowPrediction()` until ratings have
converged (~6 months):

> A "62–38" prediction based on 3 games is a LIE, and it will fail publicly in
> front of 22 people. You only lose that trust once.

**Shipping a feature you've already built, only once it's trustworthy, is a
product decision worth talking about.**

---

### 2.8 Permissions modelled on reversibility

Most apps gate permissions by *importance*. This one gates by **reversibility**:

| Tier | Needs a code? | Can do | Why |
|---|---|---|---|
| Player | No | Pause / un-pause / mark someone left | Undoable in one tap |
| Manager | `APP_CODE_MGR` | Check-in, assign, record, swap, mode, start/end | Undoable within the session |
| Admin | `APP_CODE_ADM` | Create/delete sessions, CRUD players | **Not** undoable |

The interesting case is that pausing someone is deliberately open to everyone.
The scenario from `CLAUDE.md`: someone's court frees up while they're in the
toilet. The person who taps "pause" for them has to be whoever is sitting out
and sees it happen — not them (they're absent) and not necessarily a manager (he
might be on court).

Gating that to Manager causes the exact failure the feature exists to prevent:
people stand around, someone shouts, the queue becomes a lie.

The threat model is stated plainly: *"someone taps the wrong thing,"* not
*"someone attacks us."* 22 people who know each other, one tap to undo, and the
audit log records who did it.

> **In an interview:** "Authorisation is tiered by reversibility rather than
> importance, with the threat model written down. It was tried at manager-tier
> once and reverted, because the friction broke the use case it existed to
> serve." That's a design decision, a rejected alternative, and a reason — which
> is exactly the shape of answer interviewers are listening for.

---

### 2.9 Empty states, and not showing nothing

`app/page.tsx` is the home screen — and the app is asleep 167 hours a week, so
most opens land on it when nothing is happening. Two components handle that:

```tsx
if (!data || data.possible === 0) return null;   // MixingTeaser
if (!sessions || sessions.length === 0) return null;   // RecentSessions
```

Both render **nothing** until there is real signal. The comments explain:

> Renders nothing until there's real signal (no 0/0, no flash of empty while
> loading).

Two distinct failure modes are being avoided:

1. **Meaningless zeroes.** "You've played with 0 of 0 people" is worse than
   silence — it looks broken.
2. **Layout shift.** Rendering a placeholder and then replacing it makes content
   jump. (`undefined` = still loading, `null` = loaded but empty — the
   distinction is what lets it stay silent while loading.)

The positive version of the same instinct: the mid-week home screen is filled
with the last three sessions, so the screen has a reason to exist even when no
badminton is on.

Also note what's *absent* — no skeleton loaders, no avatars, no confetti, no
badges, no streaks. `CLAUDE.md` keeps an explicit "do not build" list.
**Maintaining a written list of things you've decided not to build is a scope
discipline most portfolios don't demonstrate.**

---

### 2.10 Accessibility

Three things are already right, and worth knowing by name:

**Contrast.** The palette targets WCAG AA (4.5:1 for body text). This was tested
for real: when the launch video was built, an automated WCAG pass flagged the
signal orange `#FF4D2E` on the `signal-dim` background at **3.04:1** — below AA.
It was lifted to `#ff8f7b` to pass. A palette that looks fine can still fail
measurement; the fix is to measure.

**Reduced motion.** `app/globals.css` respects the OS-level setting:

```css
@media (prefers-reduced-motion: reduce) {
  * { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; }
}
```

Vestibular disorders make animation genuinely unpleasant, and users can say so
at the OS level. Honouring it is three lines.

**Semantics.** `CourtDiagram` carries `role="img"` and `aria-label="Court"`, so
a screen reader announces it as one image rather than reading loose SVG text.

**Where it's weaker, and worth saying so honestly:** the queue rows are
`<button>` elements (good — keyboard reachable), but this is a touch-first app
that hasn't been through a full keyboard-navigation or screen-reader pass.
Knowing your own gaps is more credible than claiming none.

---

### 2.11 The design questions you should expect

**"Why dark mode only?"**
Not an omission — a decision. Sports halls have high-bay lighting and glare; a
white screen glares, a dark ground cuts it. One mode also halves the design
surface, and there's no user research suggesting anyone wanted light mode in a
hall.

**"How would you know if the design worked?"**
It's already instrumented: every Swap logs `accepted: false`. If managers
override the suggestion often, the algorithm or its explanation is wrong. The
qualitative signal is arguments about the queue — the queue is public
specifically to erase them.

**"What would you change?"**
Honest answers: full keyboard/screen-reader pass; the algorithm has no way to
learn from rejections (they're logged but nothing consumes them); and the
one-signal-colour rule is strict enough that a genuinely urgent second state
would have nowhere to go.

**"Walk me through a decision you reversed."**
Pause/un-pause was built at manager-tier, then moved to player-tier, because
requiring a code broke the use case — the person who sees a court free up isn't
necessarily the person holding the code.

---

## Part 3 — Using this in an application

**Lead with the concurrency problem.** Two phones, same player, one transaction.
It's a real distributed-systems problem with a correct solution and a test that
proves it, found in a badminton club rather than a textbook.

**Have one number ready.** Pair-history decay was tried and *dropped* mixing
coverage from 78.8% to 76.9%, so it was rejected. Candidates who can quote a
measurement from their own project are rare.

**Use the constraint as the frame.** "The admin is also playing badminton, so
the app has to run without anyone leaving the court." Every decision — 56px
targets, one-screen layout, the reason sentence, the mode switch — follows from
it. Interviewers remember frames, not feature lists.

**Be straightforward about AI assistance.** This project was built with heavy AI
help, and that's visible in the commit history. The defensible position is not
to downplay it but to show the judgement layer: a protected core that AI is
forbidden to modify, documented experiments that were tried and rejected with
numbers, a written list of features deliberately not built, and 121 tests as the
gate. Directing and constraining AI output *is* the skill — what makes it
credible is being able to explain any decision in this document in your own
words.

Which is what this document is for. If you can't yet explain a section, open the
file it points at and read the comments — the reasoning is written next to the
code.
