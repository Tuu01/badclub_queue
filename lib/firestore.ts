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
import { updateRatings } from './rating';

import {
  getFirestore, doc, collection, runTransaction,
  Timestamp, type Transaction, type Firestore,
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
  await runTransaction(db, async (tx: Transaction) => {
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
): Promise<{ alreadyRecorded: boolean }> {
  const sRef = db.doc(`sessions/${sessionId}`);
  const gRef = db.doc(`sessions/${sessionId}/games/${args.gameId}`);
  const pRef = db.doc(`clubs/${clubId}/meta/pairStats`);
  const aRef = db.collection(`sessions/${sessionId}/audit`).doc();

  return runTransaction(db, async (tx: Transaction) => {
    // --- ĐỌC HẾT TRƯỚC (Firestore bắt buộc: mọi read trước mọi write) ---
    const [sSnap, gSnap, pSnap] = await Promise.all([
      tx.get(sRef), tx.get(gRef), tx.get(pRef),
    ]);
    const s = sSnap.data() as SessionDoc;
    const g = gSnap.data() as Game | undefined;

    if (!g) throw new Error('game not found');

    // --- IDEMPOTENT ---
    if (g.winner !== null || g.status === 'VOID') {
      return { alreadyRecorded: true };       // ← không phải lỗi. Trả 200.
    }

    const stats = (pSnap.data() as PairStatsDoc | undefined)?.pairs ?? {};

    const [a1, a2] = g.teamA;
    const [b1, b2] = g.teamB;
    const four = [a1, a2, b1, b2];

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
    tx.set(aRef, { at: now, actor: args.actor, action: 'RESULT', payload: { ...args, before } });

    return { alreadyRecorded: false };
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

  return runTransaction(db, async (tx: Transaction) => {
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
  await runTransaction(db, async (tx) => {
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
