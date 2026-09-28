# The demo deployment

The public demo is a **separate** Vercel project against a **separate** Firebase
project, seeded with fictional players. It shares nothing with the club's live
deployment — different project, different database, different credentials.

| | Public demo | Live club |
|---|---|---|
| URL | `vlong.tuuhyped.co.uk` (also `badclub-queue-demo.vercel.app`) | `badclub-vlong.vercel.app` |
| Vercel project | `badclub-queue-demo` | `badclub-vlong` |
| Firebase project | `badclub-queue-demo` | `badclub-vlong` |
| Data | 30 fictional players | Real members |
| Access codes | `demo-mgr` / `demo-adm`, published | Private |

The custom domain points at the **demo**, so the public link shows fictional
data. The club's own app keeps running on its Vercel URL against the real
database — the two were never merged, and moving the domain back is one command:

```bash
npx vercel domains add vlong.tuuhyped.co.uk badclub-vlong --force
```

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
