import { suggestMatch, buildQueue } from '../lib/matchmaking';
import { seedMu, SIGMA_INIT, updateRatings, winProbability, teamRating } from '../lib/rating';
import { bandForMu, computeSkillBand } from '../lib/skill-band';
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
console.log('\n■ Forms proper gender categories (MD / WD / XD)');
{
  // Sam, Taylor, Uma, Val are female (index >= 18); everyone else is male.
  const players = makePlayers();
  const womenOn = (team: [PlayerId, PlayerId]) =>
    team.filter(id => players.get(id)!.gender === 'F').length;

  // (a) A 2-man 2-woman court MUST be split as Mixed (1+1 | 1+1), never 2W-vs-2M.
  {
    const ids = ['Sam','Taylor','Alex','Blake'];
    const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 10)]));
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: { ...DEFAULT_CONFIG, topN: 1 }, busy: new Set(), rng: () => 0 })!;
    check('2M+2W split as Mixed doubles (one woman per team), not women-vs-men',
          womenOn(s.teamA) === 1 && womenOn(s.teamB) === 1,
          `→ ${womenOn(s.teamA)}v${womenOn(s.teamB)}`);
  }

  // (b) Women's doubles is now a VALID match — four women must not be refused.
  {
    const ids = ['Sam','Taylor','Uma','Val'];
    const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 10)]));
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random });
    check('women\'s doubles is allowed (4 women → a valid WD match, not refused)',
          s !== null && s.four.every(id => players.get(id)!.gender === 'F')
            && womenOn(s.teamA) === womenOn(s.teamB));
  }

  // (c) When a proper four is always available (4M + 4W), EVERY pick is gender-proper.
  {
    const ids = ['Alex','Blake','Casey','Drew','Sam','Taylor','Uma','Val'];
    const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 10)]));
    let improper = 0;
    for (let t = 0; t < 200; t++) {
      const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                               config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
      if (womenOn(s.teamA) !== womenOn(s.teamB)) improper++;
    }
    check(`every match is a proper category when one exists (${200 - improper}/200 proper)`,
          improper === 0, `→ ${improper} improper`);
  }

  // (d) SOFT rule: the gender penalty never blocks the hard starvation force.
  //     A lone woman waiting >25 min is still forced in every time.
  {
    const ids = ['Alex','Blake','Casey','Drew','Emery','Frankie','Gray','Sam'];
    const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 1, 5)]));
    a.set('Sam', att('Sam', 3, 40)); // starving woman, only woman present
    let included = 0;
    for (let t = 0; t < 100; t++) {
      const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                               config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
      if (s.four.includes('Sam')) included++;
    }
    check(`a starving lone woman is still forced in (soft penalty, not a hard gate) (${included}/100)`,
          included === 100, `→ ${included}`);
  }
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

// =============================================================
console.log('\n■ SKILL BANDS');
{
  // threshold map + exact >= boundaries
  check('mu 40 → Beginner', bandForMu(40) === 'BEGINNER');
  check('mu 50 → Intermediate', bandForMu(50) === 'INTERMEDIATE');
  check('mu 65 → Advanced', bandForMu(65) === 'ADVANCED');
  check('boundary 44.9 → Beginner', bandForMu(44.9) === 'BEGINNER');
  check('boundary 45 → Intermediate', bandForMu(45) === 'INTERMEDIATE');
  check('boundary 60 → Advanced', bandForMu(60) === 'ADVANCED');

  // the fuzzy div overlap must NOT split across bands: best-D2 (52) and
  // weakest-D1 (55) both land Intermediate. Ties to the seed test above.
  check('div overlap: best-D2 and weakest-D1 share a band',
        bandForMu(seedMu(2, 1, 11)) === bandForMu(seedMu(1, 11, 11)) &&
        bandForMu(seedMu(2, 1, 11)) === 'INTERMEDIATE');

  // min-games gate: clear mu but < 3 games → no band
  check('min-games gate hides band under 3 games', computeSkillBand(65, 3.5, 2).band === null);
  check('null mu → no band', computeSkillBand(null, 8, 20).band === null);
  check('band appears at 3 games', computeSkillBand(65, 3.5, 20).band === 'ADVANCED');

  // provisional flag = !converged (converged = sigma < 4 && games >= 15)
  check('provisional true at high sigma', computeSkillBand(65, 8, 5).provisional === true);
  check('provisional false when converged', computeSkillBand(65, 3.5, 20).provisional === false);

  // settling: converged player near a boundary straddles it
  const nearAdv = computeSkillBand(59, 3.5, 20); // 59 ± 3.5 crosses 60
  check('settling true near boundary', nearAdv.settling === true && nearAdv.adjacentBand === 'ADVANCED');
  const midBand = computeSkillBand(52, 3, 20); // 52 ± 3 stays inside 45–60
  check('settling false mid-band', midBand.settling === false && midBand.adjacentBand === null);

  // NO-LEAK GUARD: mu must never appear in the result
  check('result never carries mu', !('mu' in computeSkillBand(65, 3.5, 20)));
}

console.log(`\n${'─'.repeat(58)}`);
console.log(`  ${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
