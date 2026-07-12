// ============================================================
// types.ts — Nguồn sự thật duy nhất về hình dạng dữ liệu
// ============================================================

export type PlayerId = string;

// ---------- CÂU LẠC BỘ (đổi vài tháng một lần) ----------

export interface ClubPlayer {
  id: PlayerId;
  name: string;
  gender: 'M' | 'F';
  div: 1 | 2;

  /** Thứ hạng do admin xếp TRONG div (1 = mạnh nhất). Dùng để seed rating. */
  seedRank: number;

  /** TrueSkill. Ẩn với người chơi ít nhất 3 tháng. */
  mu: number;
  sigma: number;

  /** Tổng số trận đã đánh (mọi buổi). Dùng để biết rating đã hội tụ chưa. */
  gamesTotal: number;

  /** Buổi cuối cùng người này có mặt. Để sắp "ai lâu chưa đến". */
  lastPlayedAt: number | null; // epoch ms

  isGuest: boolean;
  active: boolean;
}

// ---------- LỊCH SỬ CẶP ĐÔI (xuyên buổi, KHÔNG decay) ----------

export interface PairStats {
  /** khoá: pairKey(a, b) */
  [key: string]: {
    partnered: number;   // số lần đánh CẶP
    opposed: number;     // số lần đối đầu
    coPresent: number;   // số buổi CÙNG có mặt  ← mẫu số chuẩn hoá
  };
}

/** Khoá cặp, luôn sắp xếp để (a,b) và (b,a) là một. */
export function pairKey(a: PlayerId, b: PlayerId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// ---------- BUỔI CHƠI ----------

export type AttendanceStatus =
  | 'AVAILABLE'   // có mặt, sẵn sàng được xếp
  | 'PLAYING'     // đang trên sân
  | 'PAUSED'      // có mặt nhưng tạm không xếp (WC, nghỉ)
  | 'LEFT';       // đã về

export interface Attendance {
  playerId: PlayerId;
  status: AttendanceStatus;

  checkedInAt: number;    // epoch ms — QUAN TRỌNG: đây là mốc chờ ban đầu
  leftAt: number | null;

  /** Số trận đã đánh TỐI NAY. Gồm cả trận ghi ở chế độ RECORD. */
  gamesToday: number;

  /**
   * Thời điểm rời sân lần cuối (hoặc checkedInAt nếu chưa đánh trận nào).
   * waitTime = now - freeAt
   */
  freeAt: number;
}

export interface Court {
  index: number;                    // 0, 1, 2...
  players: [PlayerId, PlayerId, PlayerId, PlayerId] | null;  // null = trống
  teamA: [PlayerId, PlayerId] | null;
  teamB: [PlayerId, PlayerId] | null;
  startedAt: number | null;
  gameId: string | null;
}

export type SessionMode = 'OFF' | 'RECORD' | 'ASSIGN';

export interface Session {
  id: string;
  date: string;                     // YYYY-MM-DD
  courtCount: number;
  targetHeadcount: number;
  mode: SessionMode;

  /** Ai được admin chọn cho buổi này (~22 người). */
  roster: PlayerId[];

  /** Ai đang ở đâu. Khoá = playerId. */
  attendance: Record<PlayerId, Attendance>;

  courts: Court[];

  startedAt: number;
  endedAt: number | null;
}

// ---------- TRẬN ĐẤU ----------

export interface Game {
  id: string;
  sessionId: string;
  courtIndex: number;

  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];

  /** null = chưa ghi kết quả (cho phép — không được chặn việc xếp trận tiếp) */
  winner: 'A' | 'B' | null;

  /** Điểm của đội THUA (0-29). Tuỳ chọn. Lưu từ ngày đầu dù chưa dùng. */
  scoreLoser: number | null;

  /** Dự đoán của app lúc xếp trận. Để đo calibration sau này. */
  predictedProbA: number | null;

  /** App có tự xếp trận này không, hay người tự chia. */
  assignedByApp: boolean;

  startedAt: number;
  endedAt: number | null;
  status: 'OK' | 'VOID';
}

// ---------- LOG GỢI Ý (metric quan trọng nhất) ----------

export interface SuggestionLog {
  id: string;
  sessionId: string;
  at: number;
  courtIndex: number;

  suggested: [PlayerId, PlayerId, PlayerId, PlayerId];
  suggestedTeams: { a: [PlayerId, PlayerId]; b: [PlayerId, PlayerId] };
  reason: string;

  /** false = người dùng bấm "Đổi". ĐÂY LÀ ĐIỂM SỐ THẬT CỦA THUẬT TOÁN. */
  accepted: boolean;

  /** Nếu bị Đổi, người dùng chọn ai. */
  actual: [PlayerId, PlayerId, PlayerId, PlayerId] | null;
}

// ---------- CẤU HÌNH THUẬT TOÁN ----------

export interface MatchmakingConfig {
  /** Cửa sổ: lấy bao nhiêu người đầu từ hàng chờ đã sắp xếp. */
  windowSize: number;

  wRepeatPartner: number;
  wRepeatOpponent: number;
  wBalance: number;
  wWait: number;

  /** Chờ quá bao nhiêu PHÚT thì BẮT BUỘC được xếp vào trận tiếp. */
  starvationMinutes: number;

  /** Không dồn cả 4 nữ vào một sân. */
  penaltyAllWomen: number;

  /** Chỉ dùng W_BALANCE khi cả 4 người có sigma dưới ngưỡng này. */
  balanceSigmaThreshold: number;

  /** Chọn ngẫu nhiên trong top-N phương án tốt nhất (chống khoá cứng). */
  topN: number;
}

export const DEFAULT_CONFIG: MatchmakingConfig = {
  windowSize: 8,
  wRepeatPartner: 48,
  wRepeatOpponent: 12,
  wBalance: 36,
  wWait: 0.30,
  starvationMinutes: 25,
  penaltyAllWomen: 100,
  balanceSigmaThreshold: 6.0,
  topN: 3,
};

// ---------- KẾT QUẢ GỢI Ý ----------

export interface Suggestion {
  four: [PlayerId, PlayerId, PlayerId, PlayerId];
  teamA: [PlayerId, PlayerId];
  teamB: [PlayerId, PlayerId];
  predictedProbA: number;

  /** Câu giải thích hiện trên màn hình. Tính năng quan trọng nhất. */
  reason: string;

  /** Để debug / tinh chỉnh trọng số. */
  breakdown: {
    cost: number;
    repeatPartner: number;
    repeatOpponent: number;
    imbalance: number;
    waitSum: number;
    forced: PlayerId[];
  };
}
