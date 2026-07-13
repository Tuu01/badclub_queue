# UI.md — Frontend design

**Direction:** *Court Surface*
The interface is the court. White on court green. Colour is reserved for exactly one thing: **it's your turn.**

Read this alongside `PROMPT.md` (what to build) and `ARCHITECTURE.md` (how it holds together). This file is **how it should look and feel**, and why.

---

## 0. Context — every decision follows from this

This is not a desktop app. It is not read in a chair. Design for the actual moment:

| Reality | Consequence |
|---|---|
| Sweaty hands, out of breath | Touch targets ≥ 56px. No small buttons. Ever. |
| One-handed, standing up | Every action lives in thumb reach (lower half of the screen) |
| Glanced at for 3 seconds, then pocketed | The answer must be above the fold. No scrolling to find it. |
| Bright hall, overhead glare | High contrast, dark ground. A white screen glares under sports lighting. |
| The user is **looking at a real court** | The court card on screen should look like the court |
| 11 of 22 people are sitting out | The default screen serves the **waiting**, not the playing |
| App runs ~1 hour, maybe twice a month | It has no time to "gradually earn trust." It convinces on match one, or never. |

**"Modern" here does not mean more effects.** It means one decisive aesthetic choice, executed precisely, with nothing extra. The distinction comes from **discipline**, not decoration.

---

## 1. The three questions

Someone opens this app to answer exactly one of three questions:

1. **"When do I play?"** — 11 people, all session long
2. **"Who am I with, which court?"** — the moment they're called up
3. **"Court's done, record it"** — the four who just finished

**If answering any of these requires a scroll, a tap, or a hunt — the design has failed.**

One screen, top to bottom, in that order. **No nav bar. No tabs. No hamburger.**

---

## 2. Thesis

Badminton players spend the whole session looking down at a green surface marked with white lines. That is the image of the sport. The app takes that image.

- **Ground:** court green, deep and dark
- **Structure:** thin white hairlines — not grey borders, not drop shadows
- **Type:** white, like the lines, like the shuttle
- **Colour is signal, not decoration.** Exactly one hot colour exists, and it appears only when something concerns *you*.

This is a **deliberate aesthetic risk.** Most sports apps are a rainbow of status colours (green = win, red = loss, amber = waiting), which means colour stops meaning anything. Here it's almost monochrome — so when colour appears, it **means something**.

---

## 3. Tokens

```css
:root {
  /* Court — the surface, deep to shallow */
  --court-900: #061A18;   /* page ground */
  --court-800: #0B2E2A;   /* cards, surfaces */
  --court-700: #124039;   /* raised, active */

  /* Line — court markings, the shuttle */
  --line-000: #F2F6F4;    /* primary text, names */
  --line-400: #8FA8A1;    /* secondary text, labels */
  --line-700: #2C5951;    /* hairlines, dividers */
  --line-800: #1A403A;    /* fainter lines */

  /* Signal — ONLY for "this concerns you". Nowhere else. */
  --signal:     #FF4D2E;
  --signal-dim: #7A2417;

  /* Live — running state, connection dot. Use sparingly. */
  --live: #4ADE9B;
}
```

### Colour rules — non-negotiable

1. **`--signal` appears at most ONCE on screen.** If you see two red things, the design has failed.
2. **No colour for win/loss.** A match result is not an emergency. Use words.
3. **No gradients. No shadows. No glow. No glassmorphism.** A badminton court is a flat plane. So is this.
4. **Hierarchy comes from lines, not fills.** To separate two regions → one 1px `--line-700` hairline. Not a grey card.

### Light mode

There isn't one. Halls are darker than daylight, and a dark ground cuts glare under high-bay lighting. **One mode. That's a choice, not an omission.**

---

## 4. Typography

```html
<link href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@100..125,400;100..125,500&family=Instrument+Sans:wght@400;500&display=swap" rel="stylesheet">
```

```css
--font-display: 'Archivo', sans-serif;      /* variable, has a wdth axis */
--font-body:    'Instrument Sans', sans-serif;
```

**No Inter. No system-ui.** Those are what make every app look like every other app.

**Archivo at extended width** (`font-stretch: 110–120%`) carries signage / scoreboard energy — exactly right for **names** and **minutes**. It's the thing that makes this app un-mistakable for another.

### Scale

| Role | Font | Size | Weight | Width |
|---|---|---|---|---|
| **Countdown** (minutes waiting) | Archivo | 44px | 500 | 120% |
| **Names on court** | Archivo | 20px | 500 | 110% |
| **Names in queue** | Archivo | 17px | 400 | 105% |
| **Button labels** | Instrument Sans | 16px | 500 | — |
| **Clocks, game counts** | Instrument Sans | 13px | 400 | — |
| **Reason sentence** | Instrument Sans | 13px | 400 | — |
| **Eyebrow** | Instrument Sans | 11px | 500 | — |

**`font-variant-numeric: tabular-nums` is mandatory** on anything that changes (clocks, minutes). Without it the digits jump and the eye has to re-read.

**Sentence case everywhere.** No ALL CAPS — not even the eyebrow. No Title Case.

**Archivo's `wdth` axis is what gives the app its character.** It will be the first thing someone deletes to save 20KB. Don't.

---

## 5. The signature — the court card IS a court

This is what the app gets remembered for.

Each court is a horizontal rectangle drawn with the **real geometry of a badminton court**, in hairlines:

```
┌─────────────────────────────────────┐
│ ┌───┬───────────┊───────────┬───┐   │  ← doubles sideline
│ │   │           ┊           │   │   │
│ │   ├───────────┊───────────┤   │   │  ← service line
│ │   │  Tuan     ┊     Hai   │   │   │
│ │   │  Lan      ┊     Binh  │   │   │
│ │   ├───────────┊───────────┤   │   │
│ │   │           ┊           │   │   │
│ └───┴───────────┊───────────┴───┘   │
└─────────────────────────────────────┘
                 ↑ the net
```

Render as inline SVG:
- Court lines: `--line-800`, 1px. **Faint, almost invisible.** You feel them more than read them.
- Net (centre): `--line-700`, 1px, dashed.
- Names: `--line-000`, Archivo 20px.

**Why it works:** the user looks up at the court, then down at the phone. Same shape. They don't *read* — they *recognise*.

**Why it isn't decoration:** the lines encode real information (which side, which team). If it were just a pretty drawing, delete it.

### Court states

| State | Treatment |
|---|---|
| **In play** | Normal. Clock counting up in the corner. |
| **Past 22 minutes** | Clock shifts `--line-400` → `--line-000`. No colour change. It just brightens. |
| **Free, has a suggestion** | Border goes `--line-000` 1px (instead of `--line-700`). Noticeably brighter. |
| **You're in it** | Border goes `--signal`. **The only place `--signal` is ever used.** |

---

## 6. Layout

```
┌──────────────────────────────┐
│  3 courts · 19 people  10:47●│  ← status bar, 44px
├──────────────────────────────┤
│                              │
│      you're 3rd in line      │  ← eyebrow, --line-400
│                              │
│         11 min               │  ← Archivo 44px, LARGEST TYPE IN THE APP
│                              │
│   court 2 finishing ·        │  ← an ACTION, not a datum
│   time for a drink           │
│                              │
├──────────────────────────────┤  ← hairline
│  in play                     │
│  ┌────────────────────────┐  │
│  │  [court 1 diagram]     │  │
│  │  Tuan & Lan won │ Hai & Binh won │  ← 56px
│  └────────────────────────┘  │
│  ┌────────────────────────┐  │
│  │  [court 3 diagram]     │  │
│  └────────────────────────┘  │
│                              │
│  ┌────────────────────────┐  │
│  │  court 2 · suggested   │  │  ← bright border
│  │  [court diagram]       │  │
│  │  An & Nam have never   │  │  ← THE REASON. Mandatory.
│  │  partnered. Cuong has  │  │
│  │  waited longest (19m). │  │
│  │  ─────────────────────  │  │
│  │   Take court   │ Swap   │  │  ← 2:1
│  └────────────────────────┘  │
├──────────────────────────────┤
│  queue · 11 people           │
│  1  Cuong      19 min · 2    │
│  2  Ha         17 min · 1    │
│  3  You        14 min · 2    │  ← --signal-dim ground
│  4  Dung       12 min · 3    │
│  5  Thao       paused        │  ← --line-400
├──────────────────────────────┤
│   Pause me  ·  Manual teams  │  ← recessed, at the foot
└──────────────────────────────┘
```

### Principles

- **Top half = your status.** 11 of 19 are waiting. They're the majority.
- **Bottom half = action.** Thumb reach.
- **The queue lives at the bottom, always visible.** This is the single most argued-about thing at every badminton session on earth. Show it publicly and you erase most of the conflict without any algorithm.
- **There is no second screen.** Ratings, stats, history → those belong *at home*, not in the hall.

### Spacing / radius

4px scale, only: `4 · 8 · 12 · 16 · 24 · 32`. Horizontal padding: **16px**, never varies.
Court cards: `12px` radius. Buttons: `0` (they span the card, rounding lives on the card's bottom corners).

---

## 7. Components

### Result buttons

```
┌─────────────────┬─────────────────┐
│  Tuan & Lan     │  Hai & Binh     │
│  won            │  won            │
└─────────────────┴─────────────────┘
        56px tall, splitting the card width
```

**Name the team, not "Team A".** Whoever taps shouldn't have to work out which side A was. **This mistake kills a lot of sports apps.**

- Transparent ground, `--line-000` text, hairline divider.
- Active: `--court-700` ground, `scale(0.98)`, 80ms.
- **No "enter score" button.** The score appears *after* the win is tapped — one small dismissible line, 0–29. It never blocks the path.

### The suggestion card

Must carry **one sentence of reasoning** (`suggestion.reason` from `lib/matchmaking.ts`):

> *An & Nam have never partnered. Cuong has waited longest (19 min).*

**Without that sentence the app is a dictator. With it, the app is a referee.**
People argue with a referee — but people **accept** one.

The app runs one hour a week. It has no runway to "gradually earn trust." It convinces on match one, or it doesn't.

Buttons: **`Take court` (2 parts) · `Swap` (1 part)**.
`Swap` must be **always visible, never buried**. The paradox: precisely because people can see the Swap button, they rarely press it.

Every press → log `accepted: false`. **This is the project's real score.**

### The queue

Each row shows **two** numbers: `19 min · 2 games`

- **Wait time** = what the algorithm's tiebreak uses
- **Games played** = what people **argue about**

Your row: `--signal-dim` ground, `--signal` text.
Paused: whole row `--line-400`, the word "paused" replacing the numbers.

### The mode switch — a first-class control

```
┌────────┬──────────┬──────────┐
│  OFF   │  RECORD  │  ASSIGN  │
└────────┴──────────┴──────────┘
```

Not a settings page. Not a gear icon. **A visible segmented control**, switchable mid-session.

People will flip it constantly and skip whole weeks. **The app must treat that as normal, not as an error state.**

`RECORD` will be the most-used mode. Design for it first.

### Undo

After every write: a bar rises from the foot, **60 seconds**, counting down as a hairline that shortens.

```
┌──────────────────────────────┐
│ Recorded: Tuan & Lan won  Undo │
│ ▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬▬░░░░░░░░░░░ │
└──────────────────────────────┘
```

**Undo replaces the entire permissions system.** 22 people who know each other, everyone can tap everything, every mistake reversible.

### Connection state

One 7px dot beside the clock. That's all.

| | |
|---|---|
| `--live` | Synced |
| `--line-400` | Reconnecting |
| `--signal` + **result buttons disabled** | Offline > 15s. *"What you're seeing is stale."* |

Hall wifi **will** fail. A red dot that says nothing is worse than no dot.

---

## 8. Motion

Frugal. People left the house for two hours specifically to **not** look at a phone.

| Yes | No |
|---|---|
| Minutes ticking down — smooth digit transition, 200ms | Blinking skeleton loaders |
| Court clock counting up, tabular | Cards sliding in, flying out |
| Undo bar shortening — linear, 60s | Confetti on a win |
| New names on court: 150ms fade | Anything over 250ms |
| Button press: `scale(0.98)`, 80ms | Parallax, hover effects (there's no mouse) |

`prefers-reduced-motion` → kill everything except the undo bar (it carries information).

---

## 9. Optimistic updates

Tapping must give **instant** feedback. Do not wait for the server.

```
tap "Hai & Binh won"
   → court 2 goes empty IMMEDIATELY, small spinner
   → POST fires in the background
   → 200 OK → spinner clears
   → 500    → roll back, toast "Couldn't save. Retry?"
```

**If they tap and nothing happens for 3 seconds, they will tap again. And again.**

This is why idempotency (`gameId`) is mandatory at the server — see `ARCHITECTURE.md` §4. The two decisions are one decision.

---

## 10. Copy

Write from the user's side of the screen, not the system's.

| Write | Don't write |
|---|---|
| `You're 3rd in line` | `Queue position: 3` |
| `Court 2 finishing · time for a drink` | `Estimated wait: 11 minutes` |
| `Tuan & Lan won` | `Team A won` |
| `Take court` | `Confirm` |
| `Swap` | `Regenerate suggestion` |
| `Offline. What you're seeing is stale.` | `Connection error!` |
| `An & Nam have never partnered.` | `Optimality score: 0.83` |
| `Waiting for a court` | `No available matches` |

**Sentence case. No exclamation marks. No apologies.** An error says what happened and what to do, in one sentence.

---

## 11. Quality floor — never announced

- Touch targets ≥ 56px, no exceptions
- Contrast ≥ 4.5:1 on every text/ground pair. Check `--line-400` on `--court-800` (~5.2:1 ✓)
- Visible focus ring (someone will use a keyboard on a tablet)
- Works at 320px wide
- No layout shift whether or not the font has loaded (`font-display: swap`)
- **Two taps within 300ms = one tap** (wet hands double-tap)
- 409 conflicts → refetch and re-render silently. **Never surface them as errors.** They're normal.

---

## 12. Banned

- Gradients, drop shadows, glow, blur, glassmorphism
- Skeleton loaders (payload is a few KB — render immediately, or render the last known state)
- Avatars, profile pictures (22 people who all know each other's faces)
- Charts and stats inside the live-session screen
- Push notifications, badges, streaks, confetti
- Colour for win/loss
- Icons where a word is clearer
- Any colour not in §3

**Chanel:** before leaving the house, look in the mirror and **take one thing off.**

---

## 13. Ship check

Hold the phone. Stand up. **Hold it at arm's length.** Glance for 2 seconds.

- [ ] Can you answer **"when do I play?"**
- [ ] Can you find the result button **without looking hard**?
- [ ] Is there exactly **one** red thing on screen?
- [ ] With all the text stripped out, does the court diagram still tell you who's playing whom?
- [ ] Does the mode switch look like something you're *allowed* to press?

If any answer is no → fix that before adding anything new.
