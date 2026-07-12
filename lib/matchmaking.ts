// ============================================================
// matchmaking.ts — Engine ghép trận
//
// THIẾT KẾ HAI TẦNG. Đây là toàn bộ bí mật:
//
//   TẦNG 1 — CỔNG (anh bảo vệ)   → ai được vào phòng chờ?  → CÔNG BẰNG
//   TẦNG 2 — CHỌN (bà mối)       → trong phòng, chọn ai?   → TRỘN NGƯỜI
//   TẦNG 3 — CHUÔNG              → có ai bị bỏ quên không?
//
// VÌ SAO PHẢI TÁCH LÀM HAI?
//
//   Nếu một cơ chế làm cả hai việc — ví dụ "lấy 4 người chờ lâu nhất" —
//   thì bốn người ra sân cùng nhau → xuống sân cùng nhau → đồng hồ chờ
//   reset cùng lúc → LẠI lên sân cùng nhau. Vĩnh viễn.
//
//   Bạn xây một cái máy để phá bè phái, và nó tạo ra bè phái hoàn hảo
//   hơn cả bè phái tự nhiên.
//
//   Mô phỏng: FIFO thuần → 2.44 bạn cặp khác nhau/buổi, 9.3 cặp bị lặp.
//             Hai tầng   → 3.58 bạn cặp (gần như mỗi trận một bạn mới), 0 lặp.
//             Và số trận mỗi người KHÔNG đổi. Không mất gì cả.
//
// NGUYÊN TẮC GỐC:
//   ĐỪNG DÙNG MỘT CON SỐ ĐỂ TRẢ LỜI HAI CÂU HỎI.
//   Một cái là ràng buộc. Một cái là mục tiêu.
// ============================================================

import type {
  ClubPlayer, PlayerId, Attendance, PairStats,
  MatchmakingConfig, Suggestion,
} from './types';
import { pairKey } from './types';
import { teamRating, winProbability, canShowPrediction } from './rating';

const MS_PER_MIN = 60_000;

export interface MatchmakingInput {
  now: number;
  players: Map<PlayerId, ClubPlayer>;
  attendance: Map<PlayerId, Attendance>;
  pairStats: PairStats;
  config: MatchmakingConfig;
  /** Ai đang trên sân KHÁC (không được xếp vào trận này). */
  busy: Set<PlayerId>;
  /** Wildcard: người này YÊU CẦU đánh cùng người kia. Ràng buộc mềm, ưu tiên cao. */
  wildcards?: Array<[PlayerId, PlayerId]>;
  /** Cho phép inject RNG để test được (mặc định Math.random). */
  rng?: () => number;
}

// ------------------------------------------------------------
// TẦNG 1 — CỔNG
// ------------------------------------------------------------

/**
 * Sắp xếp ba tầng. Tầng dưới CHỈ chạy khi tầng trên hoà.
 *
 *   1. SỐ TRẬN đã đánh (ít nhất → đứng đầu)
 *      ← đây là thứ NGƯỜI TA CÃI NHAU VỀ NÓ. Không ai đếm phút.
 *        (Mô phỏng: cổng theo số trận → chênh lệch trận 1.54.
 *                   cổng theo thời gian chờ → 1.61. Admin đoán đúng.)
 *
 *   2. THỜI GIAN CHỜ (lâu nhất → đứng trước)
 *      ← chỉ để phân xử giữa những người CÙNG số trận
 *
 *   3. BỐC THĂM
 *      ← khi cả hai tầng trên đều hoà. Xảy ra khi 4 người vừa xuống
 *        sân cùng lúc (chờ = 0 y hệt nhau), và ở ĐẦU BUỔI (mọi người
 *        đều 0 trận, 0 phút).
 *
 *        Mô phỏng nói tầng 3 không ảnh hưởng kết quả (tầng chọn đã đủ
 *        thông minh để bù). Nhưng vẫn dùng ngẫu nhiên vì: (a) miễn phí,
 *        (b) bảo hiểm nếu sau này ai đó giảm wRepeatPartner,
 *        (c) nếu phá hoà theo tên thì "An" luôn đứng trước "Vũ" và
 *            sẽ có người để ý.
 */
export function buildQueue(
  input: MatchmakingInput,
): Array<{ id: PlayerId; games: number; waitMs: number }> {
  const { now, attendance, busy, rng = Math.random } = input;

  const pool: Array<{ id: PlayerId; games: number; waitMs: number; r: number }> = [];

  for (const [id, a] of attendance) {
    if (a.status !== 'AVAILABLE') continue;   // loại PLAYING, PAUSED, LEFT
    if (busy.has(id)) continue;
    pool.push({
      id,
      games: a.gamesToday,
      waitMs: now - a.freeAt,
      r: rng(),
    });
  }

  pool.sort((x, y) =>
    x.games - y.games          // tầng 1
    || y.waitMs - x.waitMs     // tầng 2
    || x.r - y.r               // tầng 3
  );

  return pool.map(({ id, games, waitMs }) => ({ id, games, waitMs }));
}

// ------------------------------------------------------------
// TẦNG 2 + 3 — CHỌN, có CHUÔNG
// ------------------------------------------------------------

/** Ba cách chia 4 người thành 2 đội. Chỉ có ba — không hơn. */
function splits(four: PlayerId[]): Array<[[PlayerId, PlayerId], [PlayerId, PlayerId]]> {
  const [a, b, c, d] = four;
  return [
    [[a, b], [c, d]],
    [[a, c], [b, d]],
    [[a, d], [b, c]],
  ];
}

/** Mọi tổ hợp k phần tử. */
function* combinations<T>(arr: T[], k: number): Generator<T[]> {
  const n = arr.length;
  if (k > n) return;
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.map(i => arr[i]);
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

/**
 * CHUẨN HOÁ THEO CO-ATTENDANCE — không phải đếm thô.
 *
 *   Minh đi 15/16 buổi, chưa từng cặp với Tuấn  →  0/15 = khoảng trống LỚN
 *   Lan  đi  2/16 buổi, chưa từng cặp với Tuấn  →  0/2  = chưa nói lên gì
 *
 * Đếm thô thấy cả hai đều = 0 và đối xử như nhau → nó đi lo cho Lan
 * trong khi Minh mới là lỗ hổng thật.
 *
 * Một phép chia. Đáng 2.7% độ phủ.
 *
 * KHÔNG DECAY. "An và Bình đã đánh với nhau" — sự thật đó KHÔNG HẾT HẠN.
 * (Mô phỏng: decay 0.9/tuần làm độ phủ TỤT từ 78.8% xuống 76.9%.)
 */
function repetition(stats: PairStats, a: PlayerId, b: PlayerId, kind: 'partnered' | 'opposed'): number {
  const s = stats[pairKey(a, b)];
  if (!s) return 0;
  return s[kind] / Math.max(s.coPresent, 1);
}

export function suggestMatch(input: MatchmakingInput): Suggestion | null {
  const { now, players, attendance, pairStats, config, rng = Math.random } = input;

  const queue = buildQueue(input);
  if (queue.length < 4) return null;

  // ---- CỬA SỔ ----
  const window = queue.slice(0, Math.min(config.windowSize, queue.length));

  // ---- CHUÔNG: ai chờ quá lâu → BẮT BUỘC vào trận này ----
  const starveMs = config.starvationMinutes * MS_PER_MIN;
  const forced = queue.filter(q => q.waitMs > starveMs).slice(0, 2).map(q => q.id);

  // Người bị "đói" phải nằm trong cửa sổ, kể cả khi họ không lọt top-8.
  const candidateIds = new Set(window.map(w => w.id));
  for (const f of forced) candidateIds.add(f);
  const candidates = [...candidateIds];

  const waitOf = new Map(queue.map(q => [q.id, q.waitMs]));

  // ---- WILDCARD: cặp được yêu cầu ----
  const wildSet = new Set(
    (input.wildcards ?? []).map(([a, b]) => pairKey(a, b)),
  );

  // ---- DUYỆT HẾT. C(8,4) × 3 = 210 phương án. 0.4ms. ----
  // Không cần simulated annealing. Không cần heuristic.
  // Đây là trường hợp hiếm hoi mà đáp án đúng là cách ngu ngốc nhất:
  // thử hết, và bạn ĐẢM BẢO tìm được phương án tối ưu tuyệt đối.
  type Scored = {
    four: PlayerId[]; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId];
    cost: number; rp: number; ro: number; imb: number; waitSum: number; probA: number;
  };
  const scored: Scored[] = [];

  for (const four of combinations(candidates, 4)) {
    // CHUÔNG là ràng buộc CỨNG: nếu ai đó đang đói, mọi phương án
    // không chứa họ đều bị loại thẳng.
    if (forced.length && !forced.every(f => four.includes(f))) {
      if (!four.includes(forced[0])) continue;
    }

    const four4 = four as [PlayerId, PlayerId, PlayerId, PlayerId];
    const ps = four4.map(id => players.get(id)!);
    if (ps.some(p => !p)) continue;

    const waitSum = four4.reduce((s, id) => s + (waitOf.get(id) ?? 0), 0) / MS_PER_MIN;
    const maxGames = Math.max(...four4.map(id => attendance.get(id)!.gamesToday));

    // Đừng dồn cả 4 nữ vào một sân (WD gần như bất khả thi với 3-5 nữ/22 người)
    const allWomen = ps.every(p => p.gender === 'F');

    const useBalance = canShowPrediction(ps);

    for (const [tA, tB] of splits(four4)) {
      const rp = repetition(pairStats, tA[0], tA[1], 'partnered')
               + repetition(pairStats, tB[0], tB[1], 'partnered');

      let ro = 0;
      for (const x of tA) for (const y of tB) ro += repetition(pairStats, x, y, 'opposed');

      const ra = teamRating(players.get(tA[0])!, players.get(tA[1])!);
      const rb = teamRating(players.get(tB[0])!, players.get(tB[1])!);
      const probA = winProbability(ra, rb);

      // W_BALANCE = 0 khi rating chưa hội tụ.
      // Không phải vì cân bằng không quan trọng — mà vì lúc đó
      // P(thắng) luôn ≈ 0.5 và HOÀN TOÀN VÔ NGHĨA.
      const imb = useBalance ? Math.abs(probA - 0.5) : 0;

      // Wildcard: nếu cặp này được yêu cầu → thưởng lớn
      const wild = (wildSet.has(pairKey(tA[0], tA[1])) ? 1 : 0)
                 + (wildSet.has(pairKey(tB[0], tB[1])) ? 1 : 0);

      const cost =
          config.wRepeatPartner  * rp
        + config.wRepeatOpponent * ro
        + config.wBalance        * imb
        - config.wWait           * waitSum
        + 2 * maxGames
        + (allWomen ? config.penaltyAllWomen : 0)
        - 200 * wild;

      scored.push({ four: four4, teamA: tA, teamB: tB, cost, rp, ro, imb, waitSum, probA });
    }
  }

  if (!scored.length) return null;

  // ---- CHỌN NGẪU NHIÊN TRONG TOP-N ----
  // Chống "khoá cứng hàng chờ": nếu luôn lấy top-1, các phương án
  // cost bằng nhau y hệt (rất hay xảy ra ở đầu buổi, mọi thứ đều 0)
  // sẽ luôn trả về phương án TÌM THẤY ĐẦU TIÊN — và combinations()
  // duyệt theo thứ tự cố định. Kết quả: người đứng đầu danh sách
  // luôn được chọn, tuần nào cũng vậy.
  scored.sort((a, b) => a.cost - b.cost);
  const top = scored.slice(0, Math.max(1, config.topN));
  const pick = top[Math.floor(rng() * top.length)];

  const ps = pick.four.map(id => players.get(id)!);

  return {
    four: pick.four as [PlayerId, PlayerId, PlayerId, PlayerId],
    teamA: pick.teamA,
    teamB: pick.teamB,
    predictedProbA: pick.probA,
    reason: explain(pick, players, pairStats, waitOf, forced, canShowPrediction(ps)),
    breakdown: {
      cost: pick.cost,
      repeatPartner: pick.rp,
      repeatOpponent: pick.ro,
      imbalance: pick.imb,
      waitSum: pick.waitSum,
      forced,
    },
  };
}

// ------------------------------------------------------------
// CÂU GIẢI THÍCH — tính năng quan trọng nhất của cả app
// ------------------------------------------------------------

/**
 * Không có câu này, app là KẺ ĐỘC TÀI.
 * Có nó, app là TRỌNG TÀI.
 *
 * Người ta cãi trọng tài. Nhưng người ta CHẤP NHẬN trọng tài.
 *
 * App chỉ chạy 1 tiếng/tuần — nó không có thời gian để "dần dần được
 * tin tưởng". Nó phải thuyết phục ngay ở trận đầu tiên.
 *
 * Nửa ngày code. Tỉ lệ (giá trị / công sức) cao nhất trong dự án.
 */
function explain(
  pick: { four: PlayerId[]; teamA: [PlayerId, PlayerId]; teamB: [PlayerId, PlayerId]; probA: number },
  players: Map<PlayerId, ClubPlayer>,
  stats: PairStats,
  waitOf: Map<PlayerId, number>,
  forced: PlayerId[],
  showPrediction: boolean,
): string {
  const name = (id: PlayerId) => players.get(id)?.name ?? id;
  const parts: string[] = [];

  // 1. Cặp nào mới?
  for (const t of [pick.teamA, pick.teamB]) {
    const s = stats[pairKey(t[0], t[1])];
    if (!s || s.partnered === 0) {
      parts.push(`${name(t[0])} & ${name(t[1])} chưa từng đánh cặp.`);
    }
  }

  // 2. Ai bị đói? (ưu tiên nói cái này — nó giải thích một quyết định "lạ")
  if (forced.length) {
    const f = forced[0];
    const mins = Math.round((waitOf.get(f) ?? 0) / MS_PER_MIN);
    parts.unshift(`${name(f)} đã chờ ${mins} phút — ưu tiên tuyệt đối.`);
  } else {
    // 3. Ai chờ lâu nhất trong 4 người?
    let longest = pick.four[0];
    for (const id of pick.four) {
      if ((waitOf.get(id) ?? 0) > (waitOf.get(longest) ?? 0)) longest = id;
    }
    const mins = Math.round((waitOf.get(longest) ?? 0) / MS_PER_MIN);
    if (mins >= 5) parts.push(`${name(longest)} chờ lâu nhất (${mins} phút).`);
  }

  // 4. Dự đoán — CHỈ khi rating đã hội tụ.
  // Một dự đoán "62–38" dựa trên 3 trận là một LỜI NÓI DỐI, và nó sẽ
  // sai công khai trước mặt 22 người. Bạn chỉ mất niềm tin một lần thôi.
  if (showPrediction) {
    const a = Math.round(pick.probA * 100);
    parts.push(`Dự đoán ${a}–${100 - a}.`);
  }

  return parts.join(' ') || 'Cân bằng số trận và thời gian chờ.';
}
