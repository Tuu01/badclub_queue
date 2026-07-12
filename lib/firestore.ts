// ============================================================
// firestore.ts — Tầng dữ liệu (thay cho Postgres)
//
// VÌ SAO FIRESTORE HỢP HƠN CHO APP NÀY:
//
//   Toàn bộ trạng thái buổi chơi (22 người, 3 sân, hàng chờ) vừa trong
//   MỘT document ~5KB. Giới hạn Firestore là 1MB — thừa thãi.
//
//   Hệ quả: transaction trên MỘT doc là ATOMIC theo định nghĩa.
//   Không cần SELECT ... FOR UPDATE. Không cần nghĩ về isolation level.
//   "Hai điện thoại cùng lấy An và Bình" — KHÔNG THỂ xảy ra, vì cả hai
//   đọc-ghi cùng một doc, và Firestore tự retry cái đến sau.
//
//   VÙNG NGUY HIỂM TRONG KIẾN TRÚC BIẾN MẤT.
//
// CÁI GIÁ:
//   Không JOIN, không aggregate. Sáu tháng nữa muốn tính độ phủ /
//   Brier score → phải tải hết về và tính bằng JS. Với ~940 game/năm,
//   đó là một script chạy 3 giây. Không phải vấn đề — chỉ là một script.
//
// LƯU Ý: lib/matchmaking.ts và lib/rating.ts KHÔNG ĐỔI MỘT DÒNG NÀO.
//   Lõi thuần không biết database. Đó chính là lý do nó được thiết kế thế.
// ============================================================

import type {
  ClubPlayer, PlayerId, Attendance, PairStats, Game,
  Session, MatchmakingConfig, Suggestion,
} from './types';
import { pairKey, DEFAULT_CONFIG } from './types';
import { suggestMatch } from './matchmaking';
import { updateRatings, seedMu, SIGMA_INIT } from './rating';

import {
  getFirestore, Timestamp, type Transaction, type Firestore,
} from 'firebase-admin/firestore';

// ============================================================
// CẤU TRÚC DỮ LIỆU
// ============================================================
//
//   clubs/{clubId}
//     players/{playerId}          ← 55 doc. Đổi vài tháng một lần.
//     meta/pairStats              ← MỘT doc. Map ~1485 cặp (~120KB).
//
//   sessions/{sessionId}          ← MỘT doc. TOÀN BỘ trạng thái live.
//     games/{gameId}              ← append-only, để phân tích sau
//     audit/{logId}               ← append-only, cho Undo
//
// MẸO QUAN TRỌNG:
//   Nhét BẢN SAO {id,name,gender,div,mu,sigma} của ~22 người vào chính
//   sessions/{sid}. Thế thì transaction chỉ đụng HAI doc:
//   session + pairStats. Không phải đọc 22 player doc mỗi lần xếp trận.
//
//   Đây là denormalization có chủ đích. Đừng "sửa" nó.
// ============================================================

/** Bản sao rút gọn của người chơi, nhúng trong session doc. */
export interface SessionPlayer {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;
  mu: number;
  sigma: number;
}

/** Document sessions/{sid} — TOÀN BỘ trạng thái live. ~5KB. */
export interface SessionDoc {
  id: string;
  clubId: string;
  date: string;
  courtCount: number;
  targetHeadcount: number;
  mode: 'OFF' | 'RECORD' | 'ASSIGN';

  /** Bản sao 22 người. Denormalized có chủ đích. */
  players: Record<PlayerId, SessionPlayer>;

  /** Ai đang ở đâu. Admin check-in ghi cả 22 người trong MỘT write. */
  attendance: Record<PlayerId, {
    status: 'AVAILABLE' | 'PLAYING' | 'PAUSED' | 'LEFT';
    checkedInAt: number;
    leftAt: number | null;
    gamesToday: number;
    freeAt: number;       // wait = now - freeAt
  }>;

  courts: Array<{
    idx: number;
    gameId: string | null;    // null = trống
    players: PlayerId[] | null;
    teamA: [PlayerId, PlayerId] | null;
    teamB: [PlayerId, PlayerId] | null;
    startedAt: number | null;
  }>;

  startedAt: number;
  endedAt: number | null;
}

/** Document clubs/{cid}/meta/pairStats. KHÔNG DECAY. Nhớ mãi mãi. */
export interface PairStatsDoc {
  /** khoá: "playerA|playerB" (đã sắp xếp) */
  pairs: PairStats;
  updatedAt: number;
}

// ============================================================
// GIAO DỊCH 1 — CHECK-IN (admin, một write)
// ============================================================

/**
 * Admin chạm 22 tên → MỘT write.
 *
 * Đây là lý do check-in bởi admin tốt hơn tự check-in: 22 người tự chạm
 * = 22 write vào cùng một doc trong 30 giây → contention → retry.
 * Admin chạm = 1 write. Không có gì để tranh.
 *
 * QUAN TRỌNG: freeAt = checkedInAt, KHÔNG PHẢI session.startedAt.
 * Ai check-in sớm thì được đánh trước. Công bằng, và nó tự phá hoà đầu buổi.
 */
export async function checkInBatch(
  db: Firestore,
  sessionId: string,
  playerIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const ref = db.doc(`sessions/${sessionId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    const s = snap.data() as SessionDoc;

    const attendance = { ...s.attendance };
    for (const id of playerIds) {
      if (attendance[id]) continue;          // đã check-in rồi → bỏ qua (idempotent)
      attendance[id] = {
        status: 'AVAILABLE',
        checkedInAt: now,
        leftAt: null,
        gamesToday: 0,
        freeAt: now,                          // ← mốc chờ bắt đầu TỪ ĐÂY
      };
    }
    tx.update(ref, { attendance });
  });
}

// ============================================================
// GIAO DỊCH 2 — GHI KẾT QUẢ  (idempotent)
// ============================================================

/**
 * Ba người cùng bấm "Đội A thắng" ở sân 2 → CẢ BA đều thành công.
 * Không ai thấy lỗi. Không ai biết mình là người thứ hai.
 *
 * Khoá idempotency = gameId. Nếu game đã có winner → bỏ qua, trả state.
 *
 * Vì sao bắt buộc: người dùng bấm, mạng chậm, không thấy gì, bấm lại.
 * Nếu không idempotent → HAI trận được ghi → rating hỏng, số trận sai.
 *
 * Đây cũng là lý do cập nhật lạc quan ở UI an toàn.
 */
export async function recordResult(
  db: Firestore,
  sessionId: string,
  clubId: string,
  args: {
    gameId: string;
    courtIdx: number;
    winner: 'A' | 'B';
    scoreLoser?: number;
    actor: string;
  },
  now = Date.now(),
): Promise<{ alreadyRecorded: boolean; auditLogId: string | null }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const gRef = db.doc(`sessions/${sessionId}/games/${args.gameId}`);
  const pRef = db.doc(`clubs/${clubId}/meta/pairStats`);
  const rRef = db.doc(`clubs/${clubId}/private/ratings`);
  const aRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return db.runTransaction(async (tx: Transaction) => {
    // --- ĐỌC HẾT TRƯỚC (Firestore bắt buộc: mọi read trước mọi write) ---
    const [sSnap, gSnap, pSnap, rSnap] = await Promise.all([
      tx.get(sRef), tx.get(gRef), tx.get(pRef), tx.get(rRef),
    ]);
    const s = sSnap.data() as SessionDoc;
    const g = gSnap.data() as Game | undefined;

    if (!g) throw new Error('game not found');

    // --- IDEMPOTENT ---
    if (g.winner !== null || g.status === 'VOID') {
      // Lần tap đầu mới có auditLogId (để Undo) — các lần tap trùng sau
      // không cần, vì chỉ hành động GẦN NHẤT mới hoàn tác được.
      return { alreadyRecorded: true, auditLogId: null };       // ← không phải lỗi. Trả 200.
    }

    const stats = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};
    const clubRatings = (rSnap.data() as RatingsDoc | undefined)?.ratings ?? {};

    const [a1, a2] = g.teamA;
    const [b1, b2] = g.teamB;
    const four = [a1, a2, b1, b2];

    // clubs/{cid}/players/{id} chỉ tồn tại cho 55 hội viên — KHÔNG cho
    // khách vãng lai (xem addGuest). gamesTotal/lastPlayedAt vĩnh viễn
    // chỉ áp dụng cho hội viên.
    const memberIds = four.filter(id => !id.startsWith('guest-'));
    const memberRefs = memberIds.map(id => db.doc(`clubs/${clubId}/players/${id}`));
    const memberSnaps = await Promise.all(memberRefs.map(r => tx.get(r)));

    // --- SNAPSHOT ĐỂ UNDO ---
    // TrueSkill KHÔNG CÓ HÀM NGƯỢC. Không suy ra được mu cũ từ mu mới.
    // Phải lưu snapshot. 4 người → vài trăm byte. Rẻ.
    const before = {
      ratings: four.map(id => ({
        id, mu: s.players[id].mu, sigma: s.players[id].sigma,
      })),
      attendance: four.map(id => ({
        id,
        gamesToday: s.attendance[id].gamesToday,
        freeAt: s.attendance[id].freeAt,
        status: s.attendance[id].status,
      })),
      pairs: [
        pairKey(a1, a2), pairKey(b1, b2),
        pairKey(a1, b1), pairKey(a1, b2), pairKey(a2, b1), pairKey(a2, b2),
      ].map(k => ({ key: k, ...(stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 }) })),
      members: memberIds.map((id, i) => {
        const p = memberSnaps[i].data() as PublicPlayerDoc | undefined;
        return { id, gamesTotal: p?.gamesTotal ?? 0, lastPlayedAt: p?.lastPlayedAt ?? null };
      }),
    };

    // --- RATING (lõi thuần) ---
    const asClub = (id: PlayerId): ClubPlayer => ({
      ...s.players[id], seedRank: 0, gamesTotal: 0,
      lastPlayedAt: null, isGuest: false, active: true,
    });
    const updates = updateRatings(
      [asClub(a1), asClub(a2)],
      [asClub(b1), asClub(b2)],
      args.winner,
    );

    const players = { ...s.players };
    for (const u of updates) {
      players[u.playerId] = { ...players[u.playerId], mu: u.mu, sigma: u.sigma };
      // Đồng bộ VĨNH VIỄN về clubs/{cid}/private/ratings — nếu không, rating
      // chỉ sống trong session doc hôm nay và biến mất khi buổi sau tạo lại
      // từ ratings cũ. Khách vãng lai KHÔNG lưu — id của họ dùng một lần.
      if (!u.playerId.startsWith('guest-')) {
        clubRatings[u.playerId] = { mu: u.mu, sigma: u.sigma };
      }
    }

    // --- PAIR STATS (KHÔNG DECAY) ---
    const bump = (k: string, f: 'partnered' | 'opposed') => {
      const cur = stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 };
      stats[k] = { ...cur, [f]: cur[f] + 1 };
    };
    bump(pairKey(a1, a2), 'partnered');
    bump(pairKey(b1, b2), 'partnered');
    for (const x of [a1, a2]) for (const y of [b1, b2]) bump(pairKey(x, y), 'opposed');

    // --- ATTENDANCE: 4 người về hàng chờ ---
    const attendance = { ...s.attendance };
    for (const id of four) {
      attendance[id] = {
        ...attendance[id],
        status: 'AVAILABLE',
        gamesToday: attendance[id].gamesToday + 1,
        freeAt: now,                            // ← đồng hồ chờ reset
      };
    }

    // --- SÂN TRỐNG ---
    const courts = s.courts.map(c =>
      c.idx === args.courtIdx
        ? { ...c, gameId: null, players: null, teamA: null, teamB: null, startedAt: null }
        : c);

    // --- GHI ---
    tx.update(gRef, {
      winner: args.winner,
      scoreLoser: args.scoreLoser ?? null,
      endedAt: now,
    });
    tx.update(sRef, { players, attendance, courts });
    tx.set(pRef, { pairs: stats, updatedAt: now });
    tx.set(rRef, { ratings: clubRatings, updatedAt: now });
    for (let i = 0; i < memberIds.length; i++) {
      if (!memberSnaps[i].exists) continue;
      const cur = before.members[i];
      tx.update(memberRefs[i], { gamesTotal: cur.gamesTotal + 1, lastPlayedAt: now });
    }
    tx.set(aRef, {
      at: now, actor: args.actor, action: 'RESULT',
      payload: {
        gameId: args.gameId, courtIdx: args.courtIdx, winner: args.winner,
        scoreLoser: args.scoreLoser ?? null, actor: args.actor, before,
      },
    });

    return { alreadyRecorded: false, auditLogId: aRef.id };
  });
}

// ============================================================
// GIAO DỊCH 3 — XẾP NGƯỜI LÊN SÂN
//
// ĐÂY LÀ CHỖ DUY NHẤT CÓ THỂ HỎNG THEO CÁCH KHÓ SỬA.
// ============================================================

/**
 * Client ĐỀ XUẤT 4 người. Server PHÊ DUYỆT.
 *
 * Vì sao client gửi 4 người lên thay vì để server tự chọn?
 *   Vì người dùng có thể bấm "Đổi" và tự chọn ai. Server nhận danh sách,
 *   nhưng LUÔN kiểm tra lại trong transaction.
 *
 * Vì sao không thể để client tự khoá?
 *   20:14:03  sân 1 xong → client A chọn "An, Bình, Cường, Dũng"
 *   20:14:05  sân 2 xong → client B chọn "An, Bình, Em, Phong"
 *                                          ↑↑ An và Bình bị lấy HAI LẦN
 *
 * Với Firestore, transaction trên một doc là atomic. Client B đọc lại
 * và thấy An đã PLAYING → ném CONFLICT → client refetch, tính gợi ý mới.
 * Người dùng KHÔNG thấy lỗi — đây là chuyện bình thường.
 */
export class ConflictError extends Error {
  constructor(public taken: PlayerId[]) {
    super(`đã bị lấy: ${taken.join(', ')}`);
  }
}

export async function assignCourt(
  db: Firestore,
  sessionId: string,
  args: {
    courtIdx: number;
    four: [PlayerId, PlayerId, PlayerId, PlayerId];
    teamA: [PlayerId, PlayerId];
    teamB: [PlayerId, PlayerId];
    predictedProbA: number | null;
    /** false = người dùng bấm "Đổi". METRIC QUAN TRỌNG NHẤT CỦA DỰ ÁN. */
    accepted: boolean;
    suggested?: PlayerId[];
    reason?: string;
    assignedByApp: boolean;
    actor: string;
  },
  now = Date.now(),
): Promise<{ gameId: string }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const gRef = db.collection(`sessions/${sessionId}/games`).doc();
  const lRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    // --- KIỂM TRA LẠI. Đây là toàn bộ lý do transaction tồn tại. ---
    const taken = args.four.filter(id => s.attendance[id]?.status !== 'AVAILABLE');
    if (taken.length) throw new ConflictError(taken);

    const court = s.courts.find(c => c.idx === args.courtIdx);
    if (court?.gameId) throw new ConflictError([]);   // sân đã có trận rồi

    // --- KHOÁ 4 NGƯỜI ---
    const attendance = { ...s.attendance };
    for (const id of args.four) {
      attendance[id] = { ...attendance[id], status: 'PLAYING' };
    }

    const courts = s.courts.map(c =>
      c.idx === args.courtIdx
        ? { ...c, gameId: gRef.id, players: args.four,
            teamA: args.teamA, teamB: args.teamB, startedAt: now }
        : c);

    tx.set(gRef, {
      id: gRef.id, sessionId, courtIndex: args.courtIdx,
      teamA: args.teamA, teamB: args.teamB,
      winner: null,
      scoreLoser: null,
      predictedProbA: args.predictedProbA,
      assignedByApp: args.assignedByApp,
      startedAt: now, endedAt: null, status: 'OK',
    } satisfies Game);

    tx.update(sRef, { attendance, courts });

    // --- LOG GỢI Ý: điểm số THẬT của thuật toán ---
    //   < 30% bị Đổi  → thuật toán ổn
    //   > 60% bị Đổi  → sai ở đâu đó, và log này sẽ chỉ ra chỗ sai
    if (args.assignedByApp || args.suggested) {
      tx.set(lRef, {
        at: now, actor: args.actor, action: 'ASSIGN',
        payload: {
          courtIdx: args.courtIdx,
          suggested: args.suggested ?? args.four,
          actual: args.four,
          accepted: args.accepted,
          reason: args.reason ?? null,
        },
      });
    }

    return { gameId: gRef.id };
  });
}

// ============================================================
// ĐỌC — dựng input cho lõi thuần
// ============================================================

/**
 * Chuyển SessionDoc → tham số cho suggestMatch().
 *
 * Chú ý: hàm này KHÔNG gọi Date.now() và KHÔNG gọi Math.random().
 * Chúng được truyền vào. Đó là lý do lib/ test được mà không cần mock.
 */
export function buildMatchmakingInput(
  s: SessionDoc,
  pairs: PairStats,
  now: number,
  config: MatchmakingConfig = DEFAULT_CONFIG,
) {
  const players = new Map<PlayerId, ClubPlayer>();
  for (const [id, p] of Object.entries(s.players)) {
    players.set(id, {
      ...p, seedRank: 0, gamesTotal: 0,
      lastPlayedAt: null, isGuest: false, active: true,
    });
  }

  const attendance = new Map<PlayerId, Attendance>();
  for (const [id, a] of Object.entries(s.attendance)) {
    attendance.set(id, { playerId: id, ...a });
  }

  // Ai đang trên sân KHÁC
  const busy = new Set<PlayerId>();
  for (const c of s.courts) {
    if (c.players) for (const id of c.players) busy.add(id);
  }

  return { now, players, attendance, pairStats: pairs, config, busy };
}

/** Gợi ý cho một sân. KHÔNG khoá ai — chỉ là hiển thị. */
export async function getSuggestion(
  db: Firestore,
  sessionId: string,
  clubId: string,
  now = Date.now(),
): Promise<Suggestion | null> {
  const [sSnap, pSnap] = await Promise.all([
    db.doc(`sessions/${sessionId}`).get(),
    db.doc(`clubs/${clubId}/meta/pairStats`).get(),
  ]);
  const s = sSnap.data() as SessionDoc;
  const pairs = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};

  return suggestMatch(buildMatchmakingInput(s, pairs, now));
}

// ============================================================
// CO-ATTENDANCE — chạy MỘT LẦN khi chốt danh sách buổi
// ============================================================

/**
 * Cập nhật co_present cho MỌI cặp trong roster.
 *
 * Đây là MẪU SỐ của phép chuẩn hoá:
 *
 *   Minh đi 15/16 buổi, chưa từng cặp với Tuấn  →  0/15 = khoảng trống LỚN
 *   Lan  đi  2/16 buổi, chưa từng cặp với Tuấn  →  0/2  = chưa nói lên gì
 *
 * Đếm thô thấy cả hai đều = 0 và đối xử như nhau. Sai.
 *
 * Chạy MỘT LẦN khi buổi bắt đầu, không phải mỗi trận.
 * C(22,2) = 231 cặp. Một write.
 */
export async function bumpCoAttendance(
  db: Firestore,
  clubId: string,
  presentIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const ref = db.doc(`clubs/${clubId}/meta/pairStats`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(ref);
    const stats = (snap.data() as PairStatsDoc | undefined)?.pairs ?? {};

    const ids = [...presentIds].sort();
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const k = pairKey(ids[i], ids[j]);
        const cur = stats[k] ?? { partnered: 0, opposed: 0, coPresent: 0 };
        stats[k] = { ...cur, coPresent: cur.coPresent + 1 };
      }
    }
    tx.set(ref, { pairs: stats, updatedAt: now });
  });
}

// ============================================================
// NGƯỜI CHƠI — CRUD + xếp hạng seed
//
// TÁCH DOC theo firestore.rules:
//   clubs/{cid}/players/{pid}   ← đọc mở (để hiện tên). KHÔNG chứa mu/sigma.
//   clubs/{cid}/private/ratings ← chỉ server. { [playerId]: {mu, sigma} }
//
// Ẩn rating 3 tháng nghĩa là ẩn khỏi client — nên rating không được nằm
// trong doc mà client đọc trực tiếp.
// ============================================================

export interface PublicPlayerDoc {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;
  seedRank: number;
  gamesTotal: number;
  lastPlayedAt: number | null;
  isGuest: boolean;
  active: boolean;
}

/** clubs/{cid}/private/ratings — một doc, map mọi người chơi. */
export interface RatingsDoc {
  ratings: Record<PlayerId, { mu: number; sigma: number }>;
  updatedAt: number;
}

/**
 * Thêm người chơi mới. seedRank = cuối bảng div đó (đang active).
 * Admin kéo-thả sắp lại thứ tự sau (xem reorderDivision).
 */
export async function createPlayer(
  db: Firestore,
  clubId: string,
  args: { name: string; gender: 'M' | 'F'; div: 1 | 2 },
  now = Date.now(),
): Promise<PublicPlayerDoc> {
  const playersRef = db.collection(`clubs/${clubId}/players`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const ref = playersRef.doc();

  return db.runTransaction(async (tx: Transaction) => {
    const [divSnap, ratingsSnap] = await Promise.all([
      tx.get(playersRef.where('div', '==', args.div).where('active', '==', true)),
      tx.get(ratingsRef),
    ]);

    const divSize = divSnap.size + 1;
    const seedRank = divSize;
    const player: PublicPlayerDoc = {
      id: ref.id, name: args.name, gender: args.gender, div: args.div,
      seedRank, gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true,
    };

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    ratings[ref.id] = { mu: seedMu(args.div, seedRank, divSize), sigma: SIGMA_INIT };

    tx.set(ref, player);
    tx.set(ratingsRef, { ratings, updatedAt: now });
    return player;
  });
}

/** Sửa tên / giới tính / active. KHÔNG sửa div hay seedRank ở đây — dùng reorderDivision. */
export async function updatePlayer(
  db: Firestore,
  clubId: string,
  playerId: PlayerId,
  patch: Partial<Pick<PublicPlayerDoc, 'name' | 'gender' | 'active'>>,
): Promise<void> {
  await db.doc(`clubs/${clubId}/players/${playerId}`).update(patch);
}

/**
 * Kéo-thả sắp lại thứ tự TRONG một div → ghi lại seedRank + tính lại mu
 * bằng seedMu(). KHÔNG đụng sigma — sigma phản ánh số trận đã đánh thật,
 * không phải thứ hạng admin gán.
 */
export async function reorderDivision(
  db: Firestore,
  clubId: string,
  div: 1 | 2,
  orderedIds: PlayerId[],
  now = Date.now(),
): Promise<void> {
  const playersRef = db.collection(`clubs/${clubId}/players`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);

  await db.runTransaction(async (tx: Transaction) => {
    const [playerSnaps, ratingsSnap] = await Promise.all([
      Promise.all(orderedIds.map(id => tx.get(playersRef.doc(id)))),
      tx.get(ratingsRef),
    ]);

    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};

    orderedIds.forEach((id, i) => {
      if (!playerSnaps[i].exists) throw new Error(`player not found: ${id}`);
      const seedRank = i + 1;
      tx.update(playersRef.doc(id), { seedRank });
      const cur = ratings[id] ?? { mu: 0, sigma: SIGMA_INIT };
      ratings[id] = { mu: seedMu(div, seedRank, orderedIds.length), sigma: cur.sigma };
    });

    tx.set(ratingsRef, { ratings, updatedAt: now });
  });
}

// ============================================================
// CHECK-IN (bản tối giản) — /checkin vừa tạo session (nếu chưa có)
// vừa check-in trong một luồng, không qua /admin/session/new riêng.
// ============================================================

/**
 * Đảm bảo sessions/{sessionId} tồn tại và có đủ bản sao {name,gender,div,
 * mu,sigma} của những người được chọn (denormalized — xem đầu file).
 *
 * Nếu session đã tồn tại, chỉ BỔ SUNG người mới vào players (không đụng
 * người đã có — tránh ghi đè mu/sigma đã cập nhật qua các trận trong buổi).
 */
export async function ensureSessionAndPlayers(
  db: Firestore,
  clubId: string,
  args: { sessionId: string; courtCount: number; playerIds: PlayerId[] },
  now = Date.now(),
): Promise<{ created: boolean }> {
  const sRef = db.doc(`sessions/${args.sessionId}`);
  const ratingsRef = db.doc(`clubs/${clubId}/private/ratings`);
  const playersRef = db.collection(`clubs/${clubId}/players`);

  return db.runTransaction(async (tx: Transaction) => {
    const [sSnap, ratingsSnap, playerSnaps] = await Promise.all([
      tx.get(sRef),
      tx.get(ratingsRef),
      Promise.all(args.playerIds.map(id => tx.get(playersRef.doc(id)))),
    ]);

    const s = sSnap.data() as SessionDoc | undefined;
    const ratings = (ratingsSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    const players: Record<PlayerId, SessionPlayer> = { ...(s?.players ?? {}) };

    for (const snap of playerSnaps) {
      if (!snap.exists || players[snap.id]) continue;
      const p = snap.data() as PublicPlayerDoc;
      const r = ratings[p.id] ?? { mu: 50, sigma: SIGMA_INIT };
      players[p.id] = { id: p.id, name: p.name, gender: p.gender, div: p.div, mu: r.mu, sigma: r.sigma };
    }

    if (s) {
      tx.update(sRef, { players });
      return { created: false };
    }

    const doc: SessionDoc = {
      id: args.sessionId, clubId, date: args.sessionId,
      courtCount: args.courtCount, targetHeadcount: args.playerIds.length,
      mode: 'OFF', players, attendance: {},
      courts: Array.from({ length: args.courtCount }, (_, i) => ({
        idx: i, gameId: null, players: null, teamA: null, teamB: null, startedAt: null,
      })),
      startedAt: now, endedAt: null,
    };
    tx.set(sRef, doc);
    return { created: true };
  });
}

/**
 * Luồng /admin/session/new: CHỐT danh sách buổi (courts + ~22 người) —
 * KHÔNG check-in ai. Đây là lúc "chốt danh sách" thật sự (xem comment
 * bumpCoAttendance trong lib/firestore.ts) nên bump co-attendance ở
 * đây, không đợi đến /checkin.
 *
 * /checkin (đơn giản hơn) vẫn hoạt động độc lập nếu admin bỏ qua màn
 * này — ensureSessionAndPlayers là idempotent, và checkInForToday tự
 * biết KHÔNG bump lại nếu session đã tồn tại (created:false).
 */
export async function createSessionRoster(
  db: Firestore,
  clubId: string,
  args: { sessionId: string; courtCount: number; playerIds: PlayerId[] },
  now = Date.now(),
): Promise<{ created: boolean }> {
  const result = await ensureSessionAndPlayers(db, clubId, args, now);
  if (result.created) await bumpCoAttendance(db, clubId, args.playerIds, now);
  return result;
}

/**
 * Luồng /checkin: tạo session nếu cần, bump co-attendance CHỈ khi session
 * mới tạo (tránh đếm trùng nếu admin bấm check-in lại giữa buổi), rồi
 * check-in (idempotent — xem checkInBatch).
 */
export async function checkInForToday(
  db: Firestore,
  clubId: string,
  args: { sessionId: string; courtCount: number; playerIds: PlayerId[] },
  now = Date.now(),
): Promise<void> {
  const { created } = await ensureSessionAndPlayers(db, clubId, args, now);
  if (created) await bumpCoAttendance(db, clubId, args.playerIds, now);
  await checkInBatch(db, args.sessionId, args.playerIds, now);
}

// ============================================================
// CHẾ ĐỘ — OFF / RECORD / ASSIGN, đổi bất cứ lúc nào giữa buổi
// ============================================================

export async function setMode(
  db: Firestore,
  sessionId: string,
  mode: 'OFF' | 'RECORD' | 'ASSIGN',
): Promise<void> {
  await db.doc(`sessions/${sessionId}`).update({ mode });
}

// ============================================================
// TẠM NGHỈ — AVAILABLE ↔ PAUSED, chỉ qua tap tường minh (xem ARCHITECTURE.md §5).
//
// CHỈ đổi status. KHÔNG đụng freeAt — tạm nghỉ không làm mất vị trí hàng
// chờ đã tích luỹ trước đó (đi WC 5 phút không nên bị đẩy xuống cuối).
// ============================================================

export async function setPaused(
  db: Firestore,
  sessionId: string,
  playerId: PlayerId,
  paused: boolean,
): Promise<void> {
  const sRef = db.doc(`sessions/${sessionId}`);
  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;
    const cur = s.attendance[playerId];
    if (!cur || (cur.status !== 'AVAILABLE' && cur.status !== 'PAUSED')) return; // đang PLAYING/LEFT → bỏ qua
    tx.update(sRef, { [`attendance.${playerId}.status`]: paused ? 'PAUSED' : 'AVAILABLE' });
  });
}

// ============================================================
// KHÁCH VÃNG LAI — thêm thẳng vào session, KHÔNG tạo doc trong
// clubs/{cid}/players (khách không thuộc danh sách 55 người cố định).
//
// sigma khởi tạo LỚN HƠN người hội viên (15 so với 8) — đây là cơ chế
// tự bảo vệ rating hội viên khi đánh cùng khách (xem lib/rating.ts,
// updateRatings: mức thay đổi tỉ lệ sigma², không cần code gì thêm).
// ============================================================

const GUEST_SIGMA = 15;
const GUEST_MU = 50;

export async function addGuest(
  db: Firestore,
  sessionId: string,
  args: { name: string; gender: 'M' | 'F' },
  now = Date.now(),
): Promise<{ id: PlayerId }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const id = `guest-${db.collection('_ids').doc().id}`;

  await db.runTransaction(async (tx: Transaction) => {
    const snap = await tx.get(sRef);
    const s = snap.data() as SessionDoc;

    const players = {
      ...s.players,
      [id]: { id, name: args.name, gender: args.gender, div: 1 as const, mu: GUEST_MU, sigma: GUEST_SIGMA },
    };
    const attendance = {
      ...s.attendance,
      [id]: { status: 'AVAILABLE' as const, checkedInAt: now, leftAt: null, gamesToday: 0, freeAt: now },
    };

    tx.update(sRef, { players, attendance });
  });

  return { id };
}

// ============================================================
// HOÀN TÁC — chỉ trong 60 giây, chỉ hành động GẦN NHẤT.
// Hiện tại chỉ hỗ trợ hoàn tác RESULT (Step 2). Hoàn tác ASSIGN sẽ
// thêm khi ASSIGN mode được xây (Step 5) — payload assign hiện chưa
// snapshot "before" vì bản thân assign không đổi rating/pairStats.
// ============================================================

export async function undoResult(
  db: Firestore,
  sessionId: string,
  clubId: string,
  auditLogId: string,
  now = Date.now(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const aRef = db.doc(`sessions/${sessionId}/audit/${auditLogId}`);
  const pRef = db.doc(`clubs/${clubId}/meta/pairStats`);
  const rRef = db.doc(`clubs/${clubId}/private/ratings`);

  return db.runTransaction(async (tx: Transaction) => {
    const [aSnap, sSnap, pSnap, rSnap] = await Promise.all([
      tx.get(aRef), tx.get(sRef), tx.get(pRef), tx.get(rRef),
    ]);
    const audit = aSnap.data();
    if (!audit) return { ok: false, error: 'không tìm thấy log' };
    if (audit.action !== 'RESULT') return { ok: false, error: 'chỉ hoàn tác được kết quả trận đấu' };
    if (audit.undoneAt) return { ok: false, error: 'đã hoàn tác rồi' };
    if (now - audit.at > 60_000) return { ok: false, error: 'quá 60 giây — không hoàn tác được nữa' };

    const { gameId, courtIdx, before } = audit.payload as {
      gameId: string; courtIdx: number;
      before: {
        ratings: Array<{ id: PlayerId; mu: number; sigma: number }>;
        attendance: Array<{ id: PlayerId; gamesToday: number; freeAt: number; status: string }>;
        pairs: Array<{ key: string; partnered: number; opposed: number; coPresent: number }>;
        members: Array<{ id: PlayerId; gamesTotal: number; lastPlayedAt: number | null }>;
      };
    };

    const gRef = db.doc(`sessions/${sessionId}/games/${gameId}`);
    const memberRefs = before.members.map(m => db.doc(`clubs/${clubId}/players/${m.id}`));
    const [gSnap, ...memberSnaps] = await Promise.all([tx.get(gRef), ...memberRefs.map(r => tx.get(r))]);
    const g = gSnap.data() as Game | undefined;
    if (!g) return { ok: false, error: 'không tìm thấy trận' };

    const s = sSnap.data() as SessionDoc;
    const players = { ...s.players };
    const clubRatings = (rSnap.data() as RatingsDoc | undefined)?.ratings ?? {};
    for (const r of before.ratings) {
      players[r.id] = { ...players[r.id], mu: r.mu, sigma: r.sigma };
      if (!r.id.startsWith('guest-')) clubRatings[r.id] = { mu: r.mu, sigma: r.sigma };
    }

    const attendance = { ...s.attendance };
    for (const a of before.attendance) {
      attendance[a.id] = {
        ...attendance[a.id],
        gamesToday: a.gamesToday, freeAt: a.freeAt,
        status: a.status as SessionDoc['attendance'][string]['status'],
      };
    }

    const stats = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};
    for (const pr of before.pairs) stats[pr.key] = { partnered: pr.partnered, opposed: pr.opposed, coPresent: pr.coPresent };

    // Sân được recordResult() giải phóng — trả lại đúng trận đang diễn ra
    // bằng dữ liệu từ chính game doc (teamA/teamB/startedAt không đổi).
    const courts = s.courts.map(c =>
      c.idx === courtIdx
        ? { ...c, gameId: g.id, players: [...g.teamA, ...g.teamB], teamA: g.teamA, teamB: g.teamB, startedAt: g.startedAt }
        : c);

    tx.update(sRef, { players, attendance, courts });
    tx.set(pRef, { pairs: stats, updatedAt: now });
    tx.set(rRef, { ratings: clubRatings, updatedAt: now });
    for (let i = 0; i < before.members.length; i++) {
      if (!memberSnaps[i].exists) continue;
      const m = before.members[i];
      tx.update(memberRefs[i], { gamesTotal: m.gamesTotal, lastPlayedAt: m.lastPlayedAt });
    }
    tx.update(gRef, { winner: null, endedAt: null });
    tx.update(aRef, { undoneAt: now });

    return { ok: true };
  });
}
