# The demo deployment

`badclub-queue-demo.vercel.app` is a **separate** Vercel project against a
**separate** Firebase project, seeded with fictional players. It shares nothing
with the club's live deployment — different project, different database,
different credentials.

| | Live club | Public demo |
|---|---|---|
| Vercel project | `badclub-vlong` | `badclub-queue-demo` |
| Firebase project | `badclub-vlong` | `badclub-queue-demo` |
| Data | Real members | 30 fictional players |
| Access codes | Private | `demo-mgr` / `demo-adm`, published |

## Re-seeding it

Anyone can change the demo's state by tapping around, which is the point. When
it drifts too far, reset it — the seeder wipes what it wrote and lays down a
fresh club: 30 players, pair history, four finished Saturdays, one live session
mid-flow.

```bash
GOOGLE_APPLICATION_CREDENTIALS=/path/to/badclub-queue-demo-sa.json \
DEMO_PROJECT_ID=badclub-queue-demo \
node scripts/seed-demo.cjs
```

**The guard:** a real target's project id must end in `-demo`. The club's project
is `badclub-vlong`, so it can never match, whatever gets typed into the env. The
emulator path (`FIRESTORE_EMULATOR_HOST`) runs with no credentials at all and so
cannot reach any real project.

## Re-deploying it

The repo's `.vercel/` link points at the **live club** project, so a bare
`vercel --prod` deploys the real site. To deploy the demo, re-link first and put
it back afterwards:

```bash
cp .vercel/project.json /tmp/real-link.json
npx vercel link --yes --project badclub-queue-demo
npx vercel deploy --prod --yes
cp /tmp/real-link.json .vercel/project.json      # restore
```

Its nine environment variables are already set in the Vercel project, so they do
not need re-supplying on each deploy.

## If the demo is ever retired

Delete the Vercel project and the `badclub-queue-demo` Firebase project, and
remove the demo section from `README.md`. Nothing else references it.
