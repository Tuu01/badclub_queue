# Rules for Claude Code

## ⛔ DO NOT MODIFY

`lib/types.ts` · `lib/rating.ts` · `lib/matchmaking.ts`

Validated by simulation (30–40 runs × 24 weeks) and 20 unit tests.

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

## Do not build (resist the temptation)

leaderboard · win predictions · stats · charts · wildcards · chat · payments ·
logins · tournaments · native app · push notifications · badges · streaks ·
confetti · skeleton loaders · avatars