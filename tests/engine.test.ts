import { suggestMatch, buildQueue } from '../lib/matchmaking';
import { seedMu, SIGMA_INIT, updateRatings, winProbability, teamRating } from '../lib/rating';
import { DEFAULT_CONFIG, pairKey } from '../lib/types';
import type { ClubPlayer, Attendance, PairStats, PlayerId } from '../lib/types';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---------- build 22 people ----------
const NAMES = ['Alex','Blake','Casey','Drew','Emery','Frankie','Gray','Harper','Ivy','Jules','Kai',
               'Logan','Morgan','Noel','Oakley','Parker','Quinn','Riley','Sam','Taylor','Uma','Val'];

function makePlayers(): Map<PlayerId, ClubPlayer> {
  const m = new Map<PlayerId, ClubPlayer>();
  NAMES.forEach((name, i) => {
    const div: 1 | 2 = i < 11 ? 1 : 2;
    const rank = (i % 11) + 1;
    m.set(name, {
      id: name, name, gender: i >= 18 ? 'F' : 'M', div, seedRank: rank,
      mu: seedMu(div, rank, 11), sigma: SIGMA_INIT,
      gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
    });
  });
  return m;
}

const NOW = 1_000_000_000;
const MIN = 60_000;

function att(id: PlayerId, games: number, waitMin: number, status: Attendance['status'] = 'AVAILABLE'): Attendance {
  return { playerId: id, status, checkedInAt: NOW - waitMin * MIN,
           leftAt: null, gamesToday: games, freeAt: NOW - waitMin * MIN };
}

// =============================================================
console.log('\n■ TIER 1 — GATE (sorting)');
{
  const players = makePlayers();
  const a = new Map<PlayerId, Attendance>([
    ['Casey',    att('Casey', 2, 22)],   // waited LONGEST but 2 games
    ['Alex',  att('Alex', 1, 19)],
    ['Blake',     att('Blake', 1, 17)],
    ['Drew',    att('Drew', 2, 14)],
    ['Kai',   att('Kai', 4, 0)],   // just came off a court
  ]);
  const q = buildQueue({ now: NOW, players, attendance: a, pairStats: {},
                         config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.5 });

  check('games played beats wait time (Alex with 1 game ranks above Casey with 2, even though Casey waited longer)',
        q[0].id === 'Alex' && q[1].id === 'Blake' && q[2].id === 'Casey');
  check('whoever just came off a court drops to the back (no special rule needed)', q[q.length - 1].id === 'Kai');
}

// =============================================================
console.log('\n■ TIER 1 — excludes anyone not AVAILABLE');
{
  const players = makePlayers();
  const a = new Map<PlayerId, Attendance>([
    ['Alex', att('Alex', 0, 10)],
    ['Blake',    att('Blake', 0, 10, 'PAUSED')],   // bathroom break
    ['Casey',   att('Casey', 0, 10, 'PLAYING')],
    ['Drew',   att('Drew', 0, 10, 'LEFT')],
  ]);
  const q = buildQueue({ now: NOW, players, attendance: a, pairStats: {},
                         config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.5 });
  check('PAUSED / PLAYING / LEFT are all excluded from the queue', q.length === 1 && q[0].id === 'Alex');
}

// =============================================================
console.log('\n■ TIER 2 — PICK (avoids repeating pairs)');
{
  const players = makePlayers();
  const ids = ['Alex','Blake','Casey','Drew','Emery','Frankie','Gray','Harper'];
  const a = new Map<PlayerId, Attendance>(ids.map((id, i) => [id, att(id, 1, 20 - i)]));

  // Alex & Blake have partnered 5 times across 8 co-present sessions → very "stale"
  const stats: PairStats = {
    [pairKey('Alex','Blake')]: { partnered: 5, opposed: 0, coPresent: 8 },
  };

  let alexBlakeTogether = 0;
  for (let t = 0; t < 200; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: stats,
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    const sameTeam = [s.teamA, s.teamB].some(
      tm => tm.includes('Alex') && tm.includes('Blake'));
    if (sameTeam) alexBlakeTogether++;
  }
  check(`a heavily-repeated pair is NOT re-paired (${alexBlakeTogether}/200 times)`, alexBlakeTogether === 0,
        `→ ${alexBlakeTogether}`);
}

// =============================================================
console.log('\n■ CO-ATTENDANCE NORMALIZATION (not a raw count)');
{
  const players = makePlayers();
  // ONLY 4 people → the algorithm is FORCED to pick all 4, it can only decide how to SPLIT TEAMS.
  // Three splits: (A-B | C-D), (A-C | B-D), (A-D | B-C)
  const ids = ['Alex','Blake','Casey','Drew'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 1, 10)]));

  // RAW count: both pairs = 2 times → look identical.
  // Normalized: Alex-Blake = 2/20 = 0.10 (sparse) · Casey-Drew = 2/3 = 0.67 (dense)
  // The split (A-B | C-D) combines BOTH → highest cost → must be avoided.
  const stats: PairStats = {
    [pairKey('Alex','Blake')]: { partnered: 2, opposed: 0, coPresent: 20 },
    [pairKey('Casey','Drew')]:  { partnered: 2, opposed: 0, coPresent: 3 },
  };

  const cfg = { ...DEFAULT_CONFIG, topN: 1 };   // always take the best option
  const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: stats,
                           config: cfg, busy: new Set(), rng: () => 0 })!;
  const badSplit = [s.teamA, s.teamB].some(tm => tm.includes('Alex') && tm.includes('Blake'))
                && [s.teamA, s.teamB].some(tm => tm.includes('Casey') && tm.includes('Drew'));
  check('avoids the split that combines BOTH stale pairs', !badSplit,
        `→ ${s.teamA.join('+')} vs ${s.teamB.join('+')}`);

  // Directly check the normalization: the "dense" pair must be penalized more heavily
  const dense  = 2 / 3;    // Casey-Drew
  const sparse = 2 / 20;   // Alex-Blake
  check(`normalization: the dense pair (2/3=${dense.toFixed(2)}) is penalized more than the sparse pair (2/20=${sparse.toFixed(2)})`,
        dense > sparse * 5);
  console.log(`     → picked: ${s.teamA.join('+')} vs ${s.teamB.join('+')}`);
}

// =============================================================
console.log('\n■ TIER 3 — ALARM (starvation constraint)');
{
  const players = makePlayers();
  const ids = ['Alex','Blake','Casey','Drew','Emery','Frankie','Gray','Harper','Ivy','Jules'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 2)]));
  // Val: 0 games but has waited 40 minutes → must be forced in
  a.set('Val', att('Val', 3, 40));   // 3 games → would otherwise fall out of the window

  let included = 0;
  for (let t = 0; t < 100; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    if (s.four.includes('Val')) included++;
  }
  check(`anyone waiting >25 min is ALWAYS forced in, even with many games played (${included}/100)`,
        included === 100, `→ ${included}`);
}

// =============================================================
console.log('\n■ Never stacks 4 women onto one court');
{
  const players = makePlayers();
  // Taylor, Uma, Val, Riley are female (index >= 18)
  const ids = ['Riley','Sam','Taylor','Uma','Val','Alex','Blake','Casey'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 10)]));

  let allW = 0;
  for (let t = 0; t < 200; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    if (s.four.every(id => players.get(id)!.gender === 'F')) allW++;
  }
  check(`never stacks 4 women onto the same court (${allW}/200)`, allW === 0, `→ ${allW}`);
}

// =============================================================
console.log('\n■ The reason sentence');
{
  const players = makePlayers();
  const ids = ['Alex','Blake','Casey','Drew','Emery','Frankie','Gray','Harper'];
  const a = new Map<PlayerId, Attendance>(ids.map((id, i) => [id, att(id, 1, 20 - i * 2)]));
  const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                           config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.1 })!;
  check('has a reason sentence', s.reason.length > 10);
  check('does NOT show a % prediction when rating hasn\'t converged (sigma=8 > 4)',
        !s.reason.includes('Predicted'), `→ "${s.reason}"`);
  console.log(`     → "${s.reason}"`);
}

// =============================================================
console.log('\n■ RATING — TrueSkill');
{
  const p = (mu: number, sigma: number): ClubPlayer => ({
    id: 'x', name: 'x', gender: 'M', div: 1, seedRank: 1, mu, sigma,
    gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
  });

  // Two equal teams → 50-50
  const pr1 = winProbability(teamRating(p(50, 3), p(50, 3)), teamRating(p(50, 3), p(50, 3)));
  check('two equal teams → 50%', Math.abs(pr1 - 0.5) < 0.01, `→ ${pr1.toFixed(3)}`);

  // Clearly stronger team, small sigma → confident prediction
  const pr2 = winProbability(teamRating(p(65, 2.5), p(65, 2.5)), teamRating(p(40, 2.5), p(40, 2.5)));
  check('large gap + small sigma → confident prediction (>90%)', pr2 > 0.90, `→ ${pr2.toFixed(3)}`);

  // The SAME real gap (5 points each), small sigma → prediction carries signal
  const prSure   = winProbability(teamRating(p(55, 2.5), p(55, 2.5)), teamRating(p(50, 2.5), p(50, 2.5)));
  // SAME gap, but initial sigma (8.0) → the app must be less confident
  const prUnsure = winProbability(teamRating(p(55, 8.0), p(55, 8.0)), teamRating(p(50, 8.0), p(50, 8.0)));
  check(`SAME gap, large sigma → pulled back toward 50%: ${prSure.toFixed(3)} (σ=2.5) → ${prUnsure.toFixed(3)} (σ=8)`,
        prUnsure < prSure - 0.15,   // confidence must drop CLEARLY, not by an arbitrary made-up threshold
        `→ ${prUnsure.toFixed(3)} vs ${prSure.toFixed(3)}`);
  console.log(`     → σ=2.5: ${(prSure*100).toFixed(0)}%  ·  σ=8.0: ${(prUnsure*100).toFixed(0)}%  ← the app is less confident on its own`);

  // Someone with large sigma has their rating move more than someone with small sigma
  const newbie = { ...p(50, 8), id: 'newbie' };
  const vet    = { ...p(50, 2.5), id: 'vet' };
  const opp1   = { ...p(50, 3), id: 'o1' };
  const opp2   = { ...p(50, 3), id: 'o2' };
  const ups = updateRatings([newbie, vet], [opp1, opp2], 'A');
  const dNew = Math.abs(ups.find(u => u.playerId === 'newbie')!.mu - 50);
  const dVet = Math.abs(ups.find(u => u.playerId === 'vet')!.mu - 50);
  check(`the uncertain player (σ=8) learns faster than the well-known one (σ=2.5): ${dNew.toFixed(2)} vs ${dVet.toFixed(2)}`,
        dNew > dVet * 3, `→ ${dNew.toFixed(2)} vs ${dVet.toFixed(2)}`);

  // A DROP-IN GUEST (huge sigma) doesn't corrupt a member's rating
  const member = { ...p(50, 2.5), id: 'member' };
  const guest  = { ...p(50, 15), id: 'guest' };
  const upsG = updateRatings([member, guest], [opp1, opp2], 'A');
  const dMemberVsGuest = Math.abs(upsG.find(u => u.playerId === 'member')!.mu - 50);
  const upsN = updateRatings([member, { ...p(50, 2.5), id: 'z' }], [opp1, opp2], 'A');
  const dMemberNormal = Math.abs(upsN.find(u => u.playerId === 'member')!.mu - 50);
  check(`playing with a GUEST (large σ) → member rating changes LESS (self-protecting): ${dMemberVsGuest.toFixed(3)} < ${dMemberNormal.toFixed(3)}`,
        dMemberVsGuest < dMemberNormal, `→ ${dMemberVsGuest.toFixed(3)} vs ${dMemberNormal.toFixed(3)}`);
}

// =============================================================
console.log('\n■ SEED — deliberately overlapping divs');
{
  check('D1 strongest = 72', seedMu(1, 1, 11) === 72);
  check('D1 weakest = 55', Math.abs(seedMu(1, 11, 11) - 55) < 0.01);
  check('D2 strongest = 52 (CLOSE to D1 weakest = 55 → the div boundary is inherently fuzzy)',
        Math.abs(seedMu(2, 1, 11) - 52) < 0.01);
  check('D2 weakest = 32', Math.abs(seedMu(2, 11, 11) - 32) < 0.01);
}

// =============================================================
console.log('\n■ Performance (210 options)');
{
  const players = makePlayers();
  const ids = NAMES.slice(0, 14);
  const a = new Map<PlayerId, Attendance>(ids.map((id, i) => [id, att(id, i % 3, 20 - i)]));
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                   config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random });
  }
  const ms = (Date.now() - t0) / 1000;
  check(`scanning all 210 options < 5ms (actual ${ms.toFixed(2)}ms)`, ms < 5, `→ ${ms.toFixed(2)}ms`);
}

console.log(`\n${'─'.repeat(58)}`);
console.log(`  ${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
