// ============================================================
// session-estimate.ts — ước lượng cho /admin/session/new bước 1.
//
// Giả định: buổi 120 phút, mỗi trận ~20 phút (PROMPT.md) → 6 trận/sân.
//
//   games/người  = (6 trận/sân × sân × 4 người/trận) / tổng người
//                = 24 × sân / người
//   % ngồi ngoài = 1 − (giờ chơi thật / giờ có mặt)
//                = 1 − 4 × sân / người
//
// Khớp đúng ví dụ trong PROMPT.md: 3 sân, 22 người → 3.3 trận/người,
// ngồi ngoài 45%.
// ============================================================

const SESSION_MINUTES = 120;
const GAME_MINUTES = 20;
const GAMES_PER_COURT = SESSION_MINUTES / GAME_MINUTES; // 6

export interface SessionEstimate {
  gamesPerPerson: number;
  sittingOutFraction: number;
  /** người present − sân×4. Xem CẢNH BÁO NGƯỠNG SÀN trong PROMPT.md. */
  pool: number;
  poolTooSmall: boolean;
}

export function estimateSession(courts: number, headcount: number): SessionEstimate | null {
  if (courts <= 0 || headcount <= 0) return null;
  const gamesPerPerson = (GAMES_PER_COURT * courts * 4) / headcount;
  const sittingOutFraction = 1 - (4 * courts) / headcount;
  const pool = headcount - courts * 4;
  return { gamesPerPerson, sittingOutFraction, pool, poolTooSmall: pool < 8 };
}

/** Người present tối thiểu để tránh ngưỡng sàn (courts×4 + 8). */
export function safeHeadcount(courts: number): number {
  return courts * 4 + 8;
}
