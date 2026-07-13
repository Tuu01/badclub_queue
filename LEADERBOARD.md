# LEADERBOARD.md — Scoreboards, ranks, and why they matter more than the algorithm

> **STATUS: approved as a plan. NOT approved for build.**
> Only §7 Phase 1 (the session-end rating snapshot) is in scope now — and
> only because it's the one irreversible thing. Everything else waits until
> `sigma < 4.0` for real players, ~6 months. This does not override
> CLAUDE.md's "do not build: leaderboard" — that rule stands until this
> status line changes.

---

## 0. The reason this exists

Not because it's fun. Because of one number:

| Occasional players attend | Group coverage after 24 weeks |
|---|---|
| **30% of sessions (today)** | **64%** |
| 40% | 75% |
| **50%** | **86%** |
| 75% | 99% |

Pulling irregular attenders from 30% to 50%: **coverage goes 64% → 86%.**

For comparison, **every algorithmic improvement in this project combined** — the two-tier gate, anti-repetition, co-attendance normalisation — got coverage from 60% to 76%.

> ## Attendance is a bigger lever than the algorithm.

And the leaderboard is the only tool that moves attendance.

Everything below is in service of that one fact.

---

## 1. The core split: SCORE ≠ RANK

This is the decision everything else depends on. Games solved this decades ago. Copy it.

| | What it is | Does it drop when you don't show up? |
|---|---|---|
| **Score** (`1620`) | Your actual skill | **Never.** It is the truth. |
| **Rank** (`Silver II`) | Your *standing* on the board | **Yes** — requires recent activity to hold |

```
Score:  1620       ← take 3 months off, it's still 1620
Rank:   Silver II  ← needs ≥ 4 games in the last 6 weeks
                     go quiet → "Unranked" → play 3 games to get it back
```

> **You don't lose skill. You lose your place.**

This is simultaneously **honest** (the system is genuinely less sure about you) and **motivating** (if you want a rank, show up).

### The rule you must never break

> ## NEVER lower `mu` because someone was absent.

You did not get worse by missing two weeks. Lowering the score is a **lie**, and people will notice, and once they notice they will never trust the number again.

**TrueSkill already handles this correctly.** Absence inflates `sigma`, not `mu`:

```ts
// lib/rating.ts — this already exists
inflateSigmaForAbsence(player, weeksAway)
```

High `sigma` → below the confidence threshold → **"Unranked"**. No invented decay mechanic needed. The maths does it for you, and it does it *truthfully*.

---

## 2. TrueSkill, wearing an Elo costume

Players don't actually want Elo. They want **a number that goes up.**

```ts
displayScore = Math.round(mu * 20 + 500)

// mu 40 → 1300
// mu 50 → 1500
// mu 60 → 1700
// mu 72 → 1940
```

Looks like Elo. Feels like Elo. But underneath, `sigma` is protecting you from everything Elo breaks.

### Why not actually use Elo

**In a video game you play hundreds of matches a month.** Elo converges fast, and if it's wrong it self-corrects in a week.

**Here, each player plays ~2 games a week.** The rating needs **six months** to converge.

With Elo, during those six months you'd be publishing numbers that are **confident and wrong**. Someone unlucky in their first two matches sinks to the bottom of the table and **cannot climb out for months** — because K is a fixed constant and they don't play enough games to fix it.

That person quits. And you never find out it was the app's fault.

TrueSkill fixes exactly this: high `sigma` → the first few games move the rating **a lot** → mistakes correct themselves fast.

---

## 3. Four boards, not one

**A single board where the club's 3–5 women sit at the bottom is a social problem**, no matter how mathematically correct it is.

Four boards is not a social problem.

| Board | Needs a rating? | Who can climb it |
|---|---|---|
| 🤝 **Mixing** — *"played with 14 of 21"* | **No** | Everyone |
| 🔥 **Attendance** — consecutive sessions | **No** | Everyone |
| 🏆 **Skill** — score + rank | Yes | The strong |
| 📈 **Improvement** — biggest gain this month | Yes | **Anyone** |

### 📈 Improvement is the most important board

The strongest player is always top of the Skill board. That's **boring** — nobody checks a table whose answer never changes.

The **most-improved** player changes every month. That's the board weak players actually look at, and it's the board that keeps them coming back.

If you can only build two boards, build **Mixing** and **Improvement**.

### 🤝 Mixing is the project's success metric

> **"You've played with 14 of 21 people. Never with: Hai, Lan, Nam."**

This isn't decoration. **It is how you find out whether the app worked.**

If this number doesn't rise, the app has failed — no matter how elegant the algorithm. And it turns the goal into a game: people will *want* to fill the list, which matters enormously because the app only assigns ~25% of matches.

> **Most people who build this kind of app never measure the thing they built it for.**

---

## 4. Three structural advantages over any game's ladder

### 1. You cannot dodge hard matches

In every normal ladder, people avoid strong opponents to protect their rating. That's what turns ladder ratings into garbage.

**Here, the app assigns the matches.** You don't choose your opponent.

> **The rating stays honest, structurally.** Chess.com and Dota cannot say this.

### 2. Cheating is impossible and pointless

There's nothing to farm. You can't smurf. You can't queue-dodge. There are 22 people who all know each other and will notice.

### 3. Unranked is honest, not punitive

*"Provisional (8/15 games)"* isn't the system withholding a reward. It's the system saying **"I don't know enough about you yet"** — which is true, and which everyone accepts.

And it is, quietly, the strongest attendance incentive in the whole design. People want out of that state.

---

## 5. Gating — when a score becomes visible

```ts
// lib/rating.ts — already exists
SIGMA_CONVERGED = 4.0
GAMES_CONVERGED = 15

isConverged(p) → p.sigma < 4.0 && p.gamesTotal >= 15
```

| Condition | Display |
|---|---|
| `isConverged()` | **1620** · Silver II |
| Not yet | **Provisional (8/15 games)** |
| Converged, but inactive > 6 weeks | **1620** · Unranked *(sigma has inflated)* |

**Do not publish a score before it converges.** At ~2 games a week, that's ~6 months.

Publishing a number that's wrong by ±8 in front of 22 people creates drama, **and the number will in fact be wrong.** You get to lose their trust exactly once.

---

## 6. What's missing from the data today

### ❌ Rating history — you have none

You store the **current** `mu`. There is no snapshot. There is no way to know what Minh's score was last month.

**Without it, the Improvement board cannot exist.** Ever.

### The fix — 30 minutes, do it this week

Snapshot every player's `mu`/`sigma` when a session ends. One doc per session, ~22 rows. A few KB.

```ts
// sessions/{sid}/snapshot  — written once, at End Session
{
  at: 1721390400000,
  ratings: [
    { id: 'p1', mu: 52.1, sigma: 5.8, gamesTotal: 12 },
    ...
  ]
}
```

**Collect it from session one.** You can't go back and get it later.

*(In theory you could replay it from `games` — but that means recomputing the entire history every time someone opens the board. The snapshot is far cheaper, and it's the same reason `pairStats` exists as a cache.)*

### ✅ Everything else, you already have

| Board | Data source | Status |
|---|---|---|
| Mixing | `pairStats.partnered > 0` → count distinct | ✅ ready |
| Attendance | `attendance` across sessions | ✅ ready |
| Skill | `mu`, `sigma`, `gamesTotal` | ✅ ready |
| Improvement | `mu` history | ❌ **needs the snapshot** |

---

## 7. Rollout — three phases, and the order matters

### Phase 1 · Week 1 (this week) — collect, don't display

**30 minutes.** Write the session-end rating snapshot. Show nobody anything.

This is **data collection, not a feature.** But it is the only irreversible decision on this page — every week you skip is a week of history you can never reconstruct.

### Phase 2 · Weeks 2–5 — the two boards that need no rating

```
🤝 Mixing        "You've played with 14 of 21 people"
                 "Never with: Hai, Lan, Nam"

🔥 Attendance    "6 sessions in a row"
                 "You've been to 14 of the last 16"
```

**Correct from day one. Nobody can argue with them. They offend nobody.**

This is where the retention loop actually starts. Not in month six.

### Phase 3 · Month 6 — the rating boards

Only when players start crossing `sigma < 4.0 && games >= 15`.

```
🏆 Skill         1620 · Silver II
📈 Improvement   +85 this month
```

Ship Improvement **at the same time** as Skill, never after. A Skill board on its own is a board that says "the strong are strong," and the people who most need a reason to come back are the ones it discourages.

---

## 8. UI — where the boards live

**Not on `/`.**

`/` is the hall. It answers three questions: *when do I play · who with · record the result*. Nothing else belongs there.

Boards live at **`/me`** and **`/board`** — read at home, on the sofa, on Tuesday.

```
/me                    Your page.
                       Score (or "Provisional 8/15")
                       "Played with 14 of 21 · never with Hai, Lan, Nam"
                       "6 sessions in a row"
                       Your rating over time (once snapshots exist)

/board                 The four boards, tabbed.
                       Default tab: MIXING, not SKILL.
                       ← this default is a deliberate statement of what
                         the club values. Don't quietly change it.
```

### Design rules

- **Score always shows its uncertainty.** `1620 ±40`. Two people 20 points apart are not meaningfully different, and the ± is the only thing that says so.
- **Guests never appear.** Someone who played 3 games and vanished forever, sitting 5th, destroys the table's credibility.
- **No podium, no medals, no confetti.** This is a badminton club, not a mobile game. The number is enough.
- **Link to `/board` from the post-session summary**, not from `/`. Nobody should be checking their rank while standing on a court.

---

## 9. The post-session summary — where the boards get their reach

The app sleeps six days a week. **This message is the only thing reminding the group it exists.**

```
Badminton · Sat 19 Jul · 19 people, 24 matches

🔥 Most sessions this month:   Tuan (4/4)
🤝 Most mixed:                 Lan — 11 different partners
🆕 First-time pairings:        An–Hai, Binh–Nam, Cuong–Thao
📈 Biggest climb:              Minh +40

→ badclub.app/board
```

Auto-generate. One tap to copy. Paste into the group chat.

At one hour a week, this isn't decoration — **it is the retention channel**, and the retention channel is the whole point of the leaderboard, and the leaderboard is the biggest lever in the project.

---

## 10. The risks

| Risk | Mitigation |
|---|---|
| **Publishing scores too early** | Gate on `sigma < 4.0 && games ≥ 15`. Six months. No exceptions. |
| **The 3–5 women sit at the bottom of a single table** | Four boards. Two of them need no skill at all. Default tab is Mixing. |
| **People start dodging hard matches to protect their score** | **Structurally impossible.** The app assigns matches. This is your unfair advantage. |
| **Someone reads `mu` out of the session doc via devtools** | Accepted v1 trade-off — already documented in `firestore.rules`. Revisit only if someone actually complains. |
| **The Skill board becomes the only one anyone looks at** | Ship Improvement at the same time. Default to Mixing. Put Mixing first in the summary. |
| **Rank decay feels punitive** | It isn't a penalty — it's `sigma` telling the truth. Say so in the UI: *"We're less sure about you now. Play 3 games."* |

---

## 11. What to do this week

**One thing. Thirty minutes.**

> Write the session-end rating snapshot.

Not the boards. Not the UI. Not the ranks. **Just the data.**

The trial session is Saturday. The boards can wait six months. But if you don't snapshot from session one, the Improvement board — **the most important board on this page** — can never be built at all.

**Everything else on this page is reversible. This is the one thing that isn't.**
