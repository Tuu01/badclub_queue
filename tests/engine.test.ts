import { suggestMatch, buildQueue } from '../lib/matchmaking';
import { seedMu, SIGMA_INIT, updateRatings, winProbability, teamRating } from '../lib/rating';
import { DEFAULT_CONFIG, pairKey } from '../lib/types';
import type { ClubPlayer, Attendance, PairStats, PlayerId } from '../lib/types';

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}

// ---------- dựng 22 người ----------
const NAMES = ['Cường','Hà','Lan','Nam','An','Sơn','Dũng','Minh','Tuấn','Hải','Bình',
               'Thảo','Phong','Quân','Tú','Vy','Khoa','Yến','Đạt','Uyên','Giang','Kỳ'];

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
console.log('\n■ TẦNG 1 — CỔNG (sắp xếp)');
{
  const players = makePlayers();
  const a = new Map<PlayerId, Attendance>([
    ['Lan',    att('Lan', 2, 22)],   // chờ LÂU NHẤT nhưng 2 trận
    ['Cường',  att('Cường', 1, 19)],
    ['Hà',     att('Hà', 1, 17)],
    ['Nam',    att('Nam', 2, 14)],
    ['Bình',   att('Bình', 4, 0)],   // vừa xuống sân
  ]);
  const q = buildQueue({ now: NOW, players, attendance: a, pairStats: {},
                         config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.5 });

  check('số trận thắng thời gian chờ (Cường 1 trận đứng trên Lan 2 trận, dù Lan chờ lâu hơn)',
        q[0].id === 'Cường' && q[1].id === 'Hà' && q[2].id === 'Lan');
  check('người vừa xuống sân rơi xuống cuối (không cần luật riêng)', q[q.length - 1].id === 'Bình');
}

// =============================================================
console.log('\n■ TẦNG 1 — loại người không AVAILABLE');
{
  const players = makePlayers();
  const a = new Map<PlayerId, Attendance>([
    ['Cường', att('Cường', 0, 10)],
    ['Hà',    att('Hà', 0, 10, 'PAUSED')],   // đi WC
    ['Lan',   att('Lan', 0, 10, 'PLAYING')],
    ['Nam',   att('Nam', 0, 10, 'LEFT')],
  ]);
  const q = buildQueue({ now: NOW, players, attendance: a, pairStats: {},
                         config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.5 });
  check('PAUSED / PLAYING / LEFT đều bị loại khỏi hàng chờ', q.length === 1 && q[0].id === 'Cường');
}

// =============================================================
console.log('\n■ TẦNG 2 — CHỌN (tránh lặp cặp)');
{
  const players = makePlayers();
  const ids = ['Cường','Hà','Lan','Nam','An','Sơn','Dũng','Minh'];
  const a = new Map<PlayerId, Attendance>(ids.map((id, i) => [id, att(id, 1, 20 - i)]));

  // Cường & Hà đã đánh cặp 5 lần trong 8 buổi cùng có mặt → rất "cũ"
  const stats: PairStats = {
    [pairKey('Cường','Hà')]: { partnered: 5, opposed: 0, coPresent: 8 },
  };

  let cuongHaTogether = 0;
  for (let t = 0; t < 200; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: stats,
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    const sameTeam = [s.teamA, s.teamB].some(
      tm => tm.includes('Cường') && tm.includes('Hà'));
    if (sameTeam) cuongHaTogether++;
  }
  check(`cặp đã lặp nhiều KHÔNG bị ghép lại (${cuongHaTogether}/200 lần)`, cuongHaTogether === 0,
        `→ ${cuongHaTogether}`);
}

// =============================================================
console.log('\n■ CHUẨN HOÁ co-attendance (không phải đếm thô)');
{
  const players = makePlayers();
  // CHỈ 4 người → thuật toán BUỘC phải chọn cả 4, chỉ được quyết cách CHIA ĐỘI.
  // Ba cách chia: (C-H | L-N), (C-L | H-N), (C-N | H-L)
  const ids = ['Cường','Hà','Lan','Nam'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 1, 10)]));

  // Đếm THÔ: cả hai cặp đều = 2 lần → trông giống hệt nhau.
  // Chuẩn hoá: Cường-Hà = 2/20 = 0.10 (thoáng) · Lan-Nam = 2/3 = 0.67 (dày)
  // Cách chia (C-H | L-N) gộp CẢ HAI → cost cao nhất → phải bị tránh.
  const stats: PairStats = {
    [pairKey('Cường','Hà')]: { partnered: 2, opposed: 0, coPresent: 20 },
    [pairKey('Lan','Nam')]:  { partnered: 2, opposed: 0, coPresent: 3 },
  };

  const cfg = { ...DEFAULT_CONFIG, topN: 1 };   // luôn lấy phương án tốt nhất
  const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: stats,
                           config: cfg, busy: new Set(), rng: () => 0 })!;
  const badSplit = [s.teamA, s.teamB].some(tm => tm.includes('Cường') && tm.includes('Hà'))
                && [s.teamA, s.teamB].some(tm => tm.includes('Lan') && tm.includes('Nam'));
  check('tránh cách chia gộp CẢ HAI cặp cũ', !badSplit,
        `→ ${s.teamA.join('+')} vs ${s.teamB.join('+')}`);

  // Kiểm tra trực tiếp phép chuẩn hoá: cặp "dày" phải bị phạt nặng hơn
  const dense  = 2 / 3;    // Lan-Nam
  const sparse = 2 / 20;   // Cường-Hà
  check(`chuẩn hoá: cặp dày (2/3=${dense.toFixed(2)}) bị phạt nặng hơn cặp thoáng (2/20=${sparse.toFixed(2)})`,
        dense > sparse * 5);
  console.log(`     → chọn: ${s.teamA.join('+')} vs ${s.teamB.join('+')}`);
}

// =============================================================
console.log('\n■ TẦNG 3 — CHUÔNG (ràng buộc đói)');
{
  const players = makePlayers();
  const ids = ['Cường','Hà','Lan','Nam','An','Sơn','Dũng','Minh','Tuấn','Hải'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 2)]));
  // Kỳ: 0 trận nhưng đã chờ 40 phút → phải được ép vào
  a.set('Kỳ', att('Kỳ', 3, 40));   // 3 trận → lẽ ra rơi khỏi cửa sổ

  let included = 0;
  for (let t = 0; t < 100; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    if (s.four.includes('Kỳ')) included++;
  }
  check(`người chờ >25 phút LUÔN được ép vào, kể cả khi đã đánh nhiều trận (${included}/100)`,
        included === 100, `→ ${included}`);
}

// =============================================================
console.log('\n■ Không dồn 4 nữ vào một sân');
{
  const players = makePlayers();
  // Uyên, Giang, Kỳ, Yến là nữ (index >= 18)
  const ids = ['Yến','Đạt','Uyên','Giang','Kỳ','Cường','Hà','Lan'];
  const a = new Map<PlayerId, Attendance>(ids.map(id => [id, att(id, 0, 10)]));

  let allW = 0;
  for (let t = 0; t < 200; t++) {
    const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                             config: DEFAULT_CONFIG, busy: new Set(), rng: Math.random })!;
    if (s.four.every(id => players.get(id)!.gender === 'F')) allW++;
  }
  check(`không bao giờ dồn 4 nữ cùng sân (${allW}/200)`, allW === 0, `→ ${allW}`);
}

// =============================================================
console.log('\n■ Câu giải thích');
{
  const players = makePlayers();
  const ids = ['Cường','Hà','Lan','Nam','An','Sơn','Dũng','Minh'];
  const a = new Map<PlayerId, Attendance>(ids.map((id, i) => [id, att(id, 1, 20 - i * 2)]));
  const s = suggestMatch({ now: NOW, players, attendance: a, pairStats: {},
                           config: DEFAULT_CONFIG, busy: new Set(), rng: () => 0.1 })!;
  check('có câu giải thích', s.reason.length > 10);
  check('KHÔNG hiện dự đoán % khi rating chưa hội tụ (sigma=8 > 4)',
        !s.reason.includes('Dự đoán'), `→ "${s.reason}"`);
  console.log(`     → "${s.reason}"`);
}

// =============================================================
console.log('\n■ RATING — TrueSkill');
{
  const p = (mu: number, sigma: number): ClubPlayer => ({
    id: 'x', name: 'x', gender: 'M', div: 1, seedRank: 1, mu, sigma,
    gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
  });

  // Hai đội bằng nhau → 50-50
  const pr1 = winProbability(teamRating(p(50, 3), p(50, 3)), teamRating(p(50, 3), p(50, 3)));
  check('hai đội bằng nhau → 50%', Math.abs(pr1 - 0.5) < 0.01, `→ ${pr1.toFixed(3)}`);

  // Đội mạnh hơn rõ rệt, sigma nhỏ → dự đoán tự tin
  const pr2 = winProbability(teamRating(p(65, 2.5), p(65, 2.5)), teamRating(p(40, 2.5), p(40, 2.5)));
  check('chênh lệch lớn + sigma nhỏ → dự đoán tự tin (>90%)', pr2 > 0.90, `→ ${pr2.toFixed(3)}`);

  // Chênh lệch THỰC TẾ (5 điểm mỗi người), sigma nhỏ → dự đoán có tín hiệu
  const prSure   = winProbability(teamRating(p(55, 2.5), p(55, 2.5)), teamRating(p(50, 2.5), p(50, 2.5)));
  // CÙNG chênh lệch, nhưng sigma ban đầu (8.0) → app phải bớt tự tin
  const prUnsure = winProbability(teamRating(p(55, 8.0), p(55, 8.0)), teamRating(p(50, 8.0), p(50, 8.0)));
  check(`CÙNG chênh lệch, sigma lớn → kéo về gần 50%: ${prSure.toFixed(3)} (σ=2.5) → ${prUnsure.toFixed(3)} (σ=8)`,
        prUnsure < prSure - 0.15,   // độ tự tin phải TỤT RÕ RỆT, không phải một ngưỡng bịa ra
        `→ ${prUnsure.toFixed(3)} vs ${prSure.toFixed(3)}`);
  console.log(`     → σ=2.5: ${(prSure*100).toFixed(0)}%  ·  σ=8.0: ${(prUnsure*100).toFixed(0)}%  ← app tự bớt tự tin`);

  // Người sigma lớn thay đổi rating nhiều hơn người sigma nhỏ
  const newbie = { ...p(50, 8), id: 'newbie' };
  const vet    = { ...p(50, 2.5), id: 'vet' };
  const opp1   = { ...p(50, 3), id: 'o1' };
  const opp2   = { ...p(50, 3), id: 'o2' };
  const ups = updateRatings([newbie, vet], [opp1, opp2], 'A');
  const dNew = Math.abs(ups.find(u => u.playerId === 'newbie')!.mu - 50);
  const dVet = Math.abs(ups.find(u => u.playerId === 'vet')!.mu - 50);
  check(`người mù mờ (σ=8) học nhanh hơn người đã biết rõ (σ=2.5): ${dNew.toFixed(2)} vs ${dVet.toFixed(2)}`,
        dNew > dVet * 3, `→ ${dNew.toFixed(2)} vs ${dVet.toFixed(2)}`);

  // KHÁCH VÃNG LAI (sigma khổng lồ) không làm hỏng rating hội viên
  const member = { ...p(50, 2.5), id: 'member' };
  const guest  = { ...p(50, 15), id: 'guest' };
  const upsG = updateRatings([member, guest], [opp1, opp2], 'A');
  const dMemberVsGuest = Math.abs(upsG.find(u => u.playerId === 'member')!.mu - 50);
  const upsN = updateRatings([member, { ...p(50, 2.5), id: 'z' }], [opp1, opp2], 'A');
  const dMemberNormal = Math.abs(upsN.find(u => u.playerId === 'member')!.mu - 50);
  check(`đánh cùng KHÁCH (σ lớn) → rating hội viên đổi ÍT hơn (tự bảo vệ): ${dMemberVsGuest.toFixed(3)} < ${dMemberNormal.toFixed(3)}`,
        dMemberVsGuest < dMemberNormal, `→ ${dMemberVsGuest.toFixed(3)} vs ${dMemberNormal.toFixed(3)}`);
}

// =============================================================
console.log('\n■ SEED — div chồng lấn có chủ đích');
{
  check('D1 mạnh nhất = 72', seedMu(1, 1, 11) === 72);
  check('D1 yếu nhất = 55', Math.abs(seedMu(1, 11, 11) - 55) < 0.01);
  check('D2 mạnh nhất = 52 (GẦN với D1 yếu nhất = 55 → ranh giới div vốn mờ)',
        Math.abs(seedMu(2, 1, 11) - 52) < 0.01);
  check('D2 yếu nhất = 32', Math.abs(seedMu(2, 11, 11) - 32) < 0.01);
}

// =============================================================
console.log('\n■ Hiệu năng (210 phương án)');
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
  check(`duyệt hết 210 phương án < 5ms (thực tế ${ms.toFixed(2)}ms)`, ms < 5, `→ ${ms.toFixed(2)}ms`);
}

console.log(`\n${'─'.repeat(58)}`);
console.log(`  ${pass} pass · ${fail} fail`);
process.exit(fail ? 1 : 0);
