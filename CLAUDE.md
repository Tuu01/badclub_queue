# Rules for Claude Code

## ⛔ DO NOT MODIFY

`lib/types.ts` · `lib/rating.ts` · `lib/matchmaking.ts`

Validated by simulation (30–40 runs × 24 weeks) and 20 unit tests.

**What "pure" actually means here** — the invariant, precisely: these three
files must have no I/O, no `Date.now()`, no `Math.random()` in logic (`now`
and `rng` are injected parameters), no network, no database. **They may
import each other** — `rating.ts` and `matchmaking.ts` are the same pure
core, one layer apart, and `matchmaking.ts` needs `rating.ts`'s
`teamRating`/`winProbability`/`canShowPrediction` to do its job. "Only ever
import `./types`" was a badly-worded version of this rule — the sibling
import isn't the violation to watch for; a stray `Date.now()`, `Math.random()`,
`fetch`, or Firestore call is.

You **will** see things that look wrong and want to improve them. The three
most commonly proposed changes — all three are WRONG:

- *Why no decay on pair history?* → Tried it. Coverage **DROPPED** 78.8% → 76.9%.
  "An and Binh played together" — that fact does not expire.
- *Why does the gate sort by games played, not wait time?* → Tried both.
  Games played wins, and it's the thing people actually argue about.
- *Why denormalise players into the session doc?* → So a transaction touches
  2 docs instead of 24. Deliberate.

**Read the comments in the file before proposing a change.** If you still
think there's a bug — point to the line, explain it, but DO NOT FIX IT. Ask me.

## Before and after every change

```bash
npm test    # must be 20/20 pass
```

If it drops below 20 → you just broke something. Stop.

## Working rules

- Work **one step at a time** through PROMPT.md. No skipping ahead.
- Finish a step → stop, show me, wait for me to say go.
- **Don't guess.** If the spec is ambiguous, ask.
- Don't add dependencies without asking first.

## Roles

> ROLES: code-based, not per-person. Firebase Auth deliberately deferred.
> Threat model is "someone taps the wrong thing," not "someone attacks us."
> Revisit ONLY if someone actually abuses it.

Three tiers, gated by REVERSIBILITY, not importance: PLAYER (no code) ·
MANAGER (`APP_CODE_MGR` — check-in, assign, record, swap, mode, start/end,
guest — all undoable within the session) · ADMIN (`APP_CODE_ADM` —
create/edit/delete sessions, CRUD players — not undoable). Do not build a
login screen, Firebase Auth, or per-person role assignment on top of this.

**Pause/un-pause/mark-LEFT are PLAYER-tier — no code required. This is
deliberate, not an oversight.** The scenario: someone's court frees up while
they're in the toilet. The person who taps "pause" for them has to be
whoever's sitting out and sees it happen — not them (they're not there) and
not necessarily a manager (he might be on court himself). Gating this to
MANAGER breaks UC-14 in exactly the way it exists to prevent: people stand
around, someone shouts, the queue becomes a lie. The abuse case (someone
maliciously pauses everyone) is a nuisance, not a threat — it's ~22 people
who know each other, it's one tap to undo, and the audit log names them.
This was tried at MANAGER-tier once already and reverted — don't "fix" it
back for consistency.

## Do not build (resist the temptation)

leaderboard · win predictions · stats · charts · wildcards · chat · payments ·
logins · tournaments · native app · push notifications · badges · streaks ·
confetti · skeleton loaders · avatars

**This means: don't build new UI or features for these.** It does NOT mean
delete math that's already in the protected core and already tested —
`isConverged()`, `inflateSigmaForAbsence()`, the `wildcards` field on
`MatchmakingInput`, and the prediction sentence in `matchmaking.ts`'s
`explain()` (gated behind `canShowPrediction()`, ~6 months of convergence)
are all dormant, correctly gated, and stay exactly as they are. Latent
capability in a pure function nobody calls yet is not the same thing as a
shipped feature.

**"leaderboard" here is now scoped by LEADERBOARD.md's STATUS line, not a
blanket ban.** `/board` (Mixing + Attendance tabs, live) and `/me` are
built and approved — see LEADERBOARD.md §7 Phase 1/2. Skill and Improvement
are locked tabs: tappable, showing real unlock progress, never a bare
"coming soon," never publishing a rating before `isConverged()`. Still off
the table: win predictions surfaced anywhere on `/board`/`/me` beyond that
gate, podiums/medals/confetti, charts, and a live Skill/Improvement board
before real convergence. Read LEADERBOARD.md's STATUS line before assuming
either direction.