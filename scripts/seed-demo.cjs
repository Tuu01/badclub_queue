// ============================================================
// seed-demo.cjs — fills the LOCAL FIRESTORE EMULATOR with a rich, fake club.
//
// NEVER touches the real club: it refuses to run unless FIRESTORE_EMULATOR_HOST
// is set, and it initialises its own Admin app with no credentials.
//
//   firebase emulators:start --only firestore        (terminal 1)
//   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/seed-demo.cjs
//
// Seeds: 30 players, spread ratings, pair history, 4 finished Saturdays,
// and ONE live session mid-flow (2 courts playing, 1 free, a real queue).
// ============================================================
const fs = require('fs');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('REFUSING TO RUN: FIRESTORE_EMULATOR_HOST is not set.');
  console.error('This script only ever seeds the local emulator, never the real club.');
  process.exit(1);
}

function readEnv(key) {
  try {
    const t = fs.readFileSync('.env.local', 'utf8');
    const m = t.match(new RegExp('^\\s*' + key + '\\s*=\\s*(.*)$', 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  } catch { return null; }
}

const PROJECT_ID = readEnv('NEXT_PUBLIC_FIREBASE_PROJECT_ID') || 'demo-badclub';
initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const CLUB = 'default';
const MIN = 60_000;
const NOW = Date.now();

// deterministic PRNG so re-seeding gives identical screenshots
let _s = 12345;
const rnd = () => ((_s = (1664525 * _s + 1013904223) >>> 0) / 4294967296);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const seedMu = (div, rank, size) => {
  const t = size <= 1 ? 0 : (rank - 1) / (size - 1);
  return div === 1 ? 72 - t * (72 - 55) : 52 - t * (52 - 32);
};
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

// The club plays SATURDAYS — the app says so on the home screen. Anchor every
// seeded session to a Saturday so the demo data doesn't contradict the copy.
//
// Use the UPCOMING Saturday for the live session: use-active-session.ts drops
// any LIVE session dated before today ("stale LIVE never resurrects"), so a
// back-dated one would correctly be ignored and the home screen would show
// "no badminton on right now".
const DAY = 86400000;
const SAT = NOW + (((6 - new Date(NOW).getDay() + 7) % 7) * DAY);

// FICTIONAL roster. Deliberately NOT the real club — these screenshots are for
// a public portfolio, and real members' names next to ratings, win/loss records
// and "never partnered with" data would expose them without consent. English
// names read neutrally for a portfolio audience; the 20M/10F split matches the
// real club, so the demo still reflects the demographic the gender-category
// matchmaking was built for.
const ROSTER = [
  // div 1 — 14
  { name: 'James Carter',   gender: 'M', div: 1 },
  { name: 'Tom Bailey',     gender: 'M', div: 1 },
  { name: 'Ryan Mitchell',  gender: 'M', div: 1 },
  { name: 'Daniel Hughes',  gender: 'M', div: 1 },
  { name: 'Oliver Grant',   gender: 'M', div: 1 },
  { name: 'Marcus Webb',    gender: 'M', div: 1 },
  { name: 'Sam Whitfield',  gender: 'M', div: 1 },
  { name: 'Ethan Brooks',   gender: 'M', div: 1 },
  { name: 'Luke Harding',   gender: 'M', div: 1 },
  { name: 'Adam Foster',    gender: 'M', div: 1 },
  { name: 'Emily Hart',     gender: 'F', div: 1 },
  { name: 'Sophie Lawson',  gender: 'F', div: 1 },
  { name: 'Grace Bennett',  gender: 'F', div: 1 },
  { name: 'Chloe Ramsey',   gender: 'F', div: 1 },
  // div 2 — 16
  { name: 'Nathan Price',   gender: 'M', div: 2 },
  { name: 'Chris Donnelly', gender: 'M', div: 2 },
  { name: 'Ben Marsh',      gender: 'M', div: 2 },
  { name: 'Jack Turnbull',  gender: 'M', div: 2 },
  { name: 'Owen Fletcher',  gender: 'M', div: 2 },
  { name: 'Alex Nolan',     gender: 'M', div: 2 },
  { name: 'Josh Kerrigan',  gender: 'M', div: 2 },
  { name: 'Liam Ashworth',  gender: 'M', div: 2 },
  { name: 'Toby Vaughan',   gender: 'M', div: 2 },
  { name: 'Elliot Shaw',    gender: 'M', div: 2 },
  { name: 'Hannah Fielding',gender: 'F', div: 2 },
  { name: 'Amy Sinclair',   gender: 'F', div: 2 },
  { name: 'Laura Prescott', gender: 'F', div: 2 },
  { name: 'Megan Doyle',    gender: 'F', div: 2 },
  { name: 'Katie Bright',   gender: 'F', div: 2 },
  { name: 'Rachel Vance',   gender: 'F', div: 2 },
];

(async () => {
  // Wipe any previous demo data so re-seeding is clean, never additive.
  // Emulator-only — the FIRESTORE_EMULATOR_HOST guard above makes sure of it.
  await db.recursiveDelete(db.collection('sessions'));
  await db.recursiveDelete(db.collection(`clubs/${CLUB}/players`));
  await db.doc(`clubs/${CLUB}/private/ratings`).delete().catch(() => {});
  await db.doc(`clubs/${CLUB}/meta/pairStats`).delete().catch(() => {});
  console.log('cleared previous demo data');

  const raw = ROSTER.map((p) => ({ ...p, bio: '' }));

  // ---------- players + ratings ----------
  const byDiv = { 1: [], 2: [] };
  raw.forEach((p) => byDiv[p.div].push(p));

  const players = [];
  ['1', '2'].forEach((dk) => {
    const div = Number(dk);
    byDiv[div].forEach((p, i) => {
      const id = `demo-${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      const games = 12 + Math.floor(rnd() * 30);          // 12–41 games
      const sigma = +(2.8 + rnd() * 2.9).toFixed(2);       // some converge (<4), some don't
      const mu = +(seedMu(div, i + 1, byDiv[div].length) + (rnd() * 6 - 3)).toFixed(2);
      players.push({
        id, name: p.name, gender: p.gender, div, seedRank: i + 1,
        gamesTotal: games, lastPlayedAt: NOW - Math.floor(rnd() * 7) * 86400000,
        isGuest: false, active: true, bio: p.bio || '',
        mu, sigma,
      });
    });
  });

  const batch1 = db.batch();
  const ratings = {};
  players.forEach((p) => {
    batch1.set(db.doc(`clubs/${CLUB}/players/${p.id}`), {
      id: p.id, name: p.name, gender: p.gender, div: p.div, seedRank: p.seedRank,
      gamesTotal: p.gamesTotal, lastPlayedAt: p.lastPlayedAt,
      isGuest: false, active: true, bio: p.bio,
    });
    ratings[p.id] = { mu: p.mu, sigma: p.sigma };
  });
  batch1.set(db.doc(`clubs/${CLUB}/private/ratings`), { ratings, updatedAt: NOW });
  await batch1.commit();
  console.log(`seeded ${players.length} players + ratings`);

  // ---------- pair history (partial mixing, so the board is interesting) ----------
  const pairs = {};
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      // Everyone has been AT sessions together (coPresent > 0 → counts as
      // "possible"), but ~40% have never actually partnered — that's what
      // fills the "Never partnered with" card and keeps mixing below 100%.
      const neverPartnered = rnd() < 0.4;
      pairs[pairKey(players[i].id, players[j].id)] = {
        partnered: neverPartnered ? 0 : 1 + Math.floor(rnd() * 3),
        opposed: Math.floor(rnd() * 5),
        coPresent: 2 + Math.floor(rnd() * 6),
      };
    }
  }
  await db.doc(`clubs/${CLUB}/meta/pairStats`).set({ pairs, updatedAt: NOW });
  console.log(`seeded ${Object.keys(pairs).length} pair records`);

  // ---------- 4 finished Saturdays ----------
  for (let w = 4; w >= 1; w--) {
    const at = SAT - w * 7 * DAY;
    const date = ymd(at);
    const present = players.filter(() => rnd() < 0.62).slice(0, 18);
    if (present.length < 8) continue;

    const sPlayers = {}, attendance = {};
    present.forEach((p) => {
      sPlayers[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: p.mu, sigma: p.sigma };
      // Ending a session doesn't mark people LEFT in the real app — their
      // status stays as it was, so the admin list still shows the turnout.
      attendance[p.id] = {
        status: 'AVAILABLE', checkedInAt: at, leftAt: null,
        gamesToday: 2 + Math.floor(rnd() * 4), freeAt: at + 110 * MIN,
      };
    });

    await db.doc(`sessions/${date}`).set({
      id: date, clubId: CLUB, date, courtCount: 3, targetHeadcount: 22,
      mode: 'ASSIGN', status: 'DONE', players: sPlayers, attendance,
      courts: [0, 1, 2].map((idx) => ({ idx, gameId: null, players: null, teamA: null, teamB: null, startedAt: null })),
      startedAt: at, endedAt: at + 125 * MIN,
    });

    // games for that night
    const gb = db.batch();
    const n = 10 + Math.floor(rnd() * 6);
    for (let g = 0; g < n; g++) {
      const four = [...present].sort(() => rnd() - 0.5).slice(0, 4);
      if (four.length < 4) break;
      const gid = `${date}-g${g}`;
      const st = at + (10 + g * 8) * MIN;
      gb.set(db.doc(`sessions/${date}/games/${gid}`), {
        id: gid, sessionId: date, courtIndex: g % 3,
        teamA: [four[0].id, four[1].id], teamB: [four[2].id, four[3].id],
        winner: rnd() < 0.5 ? 'A' : 'B', scoreLoser: Math.floor(rnd() * 20),
        predictedProbA: +(0.42 + rnd() * 0.16).toFixed(3),
        assignedByApp: true, startedAt: st, endedAt: st + 7 * MIN, status: 'OK',
      });
    }
    await gb.commit();
    console.log(`seeded finished session ${date} (${present.length} present, ${n} games)`);
  }

  // ---------- THE LIVE SESSION (the money shot) ----------
  const today = ymd(SAT);
  const roster = players.slice(0, 24);
  const sPlayers = {}, attendance = {};
  roster.forEach((p) => {
    sPlayers[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: p.mu, sigma: p.sigma };
  });

  const onCourt = roster.slice(0, 8);                 // 2 courts × 4
  const waiting = roster.slice(8);
  onCourt.forEach((p) => {
    attendance[p.id] = {
      status: 'PLAYING', checkedInAt: NOW - 95 * MIN, leftAt: null,
      gamesToday: 1 + Math.floor(rnd() * 3), freeAt: NOW - 9 * MIN,
    };
  });
  waiting.forEach((p, i) => {
    attendance[p.id] = {
      status: i === 3 ? 'PAUSED' : 'AVAILABLE',
      checkedInAt: NOW - 95 * MIN, leftAt: null,
      gamesToday: Math.floor(rnd() * 4),
      freeAt: NOW - (2 + i * 1.4) * MIN,             // spread of wait times
    };
  });

  await db.doc(`sessions/${today}`).set({
    id: today, clubId: CLUB, date: today, courtCount: 3, targetHeadcount: 24,
    mode: 'ASSIGN', status: 'LIVE', players: sPlayers, attendance,
    courts: [
      { idx: 0, gameId: `${today}-live0`, players: onCourt.slice(0, 4).map(p => p.id),
        teamA: [onCourt[0].id, onCourt[1].id], teamB: [onCourt[2].id, onCourt[3].id],
        startedAt: NOW - 9 * MIN },
      { idx: 1, gameId: `${today}-live1`, players: onCourt.slice(4, 8).map(p => p.id),
        teamA: [onCourt[4].id, onCourt[5].id], teamB: [onCourt[6].id, onCourt[7].id],
        startedAt: NOW - 4 * MIN },
      { idx: 2, gameId: null, players: null, teamA: null, teamB: null, startedAt: null },
    ],
    startedAt: NOW - 95 * MIN, endedAt: null,
  });

  const lb = db.batch();
  [0, 1].forEach((c) => {
    const four = onCourt.slice(c * 4, c * 4 + 4);
    const gid = `${today}-live${c}`;
    lb.set(db.doc(`sessions/${today}/games/${gid}`), {
      id: gid, sessionId: today, courtIndex: c,
      teamA: [four[0].id, four[1].id], teamB: [four[2].id, four[3].id],
      winner: null, scoreLoser: null, predictedProbA: 0.51,
      assignedByApp: true, startedAt: NOW - (c === 0 ? 9 : 4) * MIN, endedAt: null, status: 'OK',
    });
  });
  // a few already-recorded games tonight, so /history has content
  for (let g = 0; g < 6; g++) {
    const four = [...roster].sort(() => rnd() - 0.5).slice(0, 4);
    const gid = `${today}-done${g}`;
    const st = NOW - (80 - g * 10) * MIN;
    lb.set(db.doc(`sessions/${today}/games/${gid}`), {
      id: gid, sessionId: today, courtIndex: g % 3,
      teamA: [four[0].id, four[1].id], teamB: [four[2].id, four[3].id],
      winner: rnd() < 0.5 ? 'A' : 'B', scoreLoser: 12 + Math.floor(rnd() * 9),
      predictedProbA: +(0.45 + rnd() * 0.1).toFixed(3),
      assignedByApp: true, startedAt: st, endedAt: st + 7 * MIN, status: 'OK',
    });
  }
  await lb.commit();
  console.log(`seeded LIVE session ${today} — ${roster.length} present, 2 courts playing, 1 free`);

  console.log('\nDone. Actor to use for screenshots:');
  console.log(JSON.stringify({ id: waiting[2].id, name: waiting[2].name }));
})();
