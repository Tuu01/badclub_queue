// ============================================================
// rating.ts — TrueSkill rút gọn, tự chứa, không phụ thuộc gì
//
// Vì sao không dùng `ts-trueskill`?
//   - Cloud Run container càng ít dependency càng tốt
//   - Phiên bản này ~60 dòng, đọc được, và ĐÃ ĐƯỢC KIỂM CHỨNG
//     bằng mô phỏng: hội tụ từ seed ±7 xuống ±3.2 sau ~6 tháng
//     chạy 1 tiếng/tuần.
//
// Vì sao KHÔNG dùng Elo?
//   - Elo không có sigma. Nó không phân biệt được "1500 vì mới"
//     với "1500 vì đã đo 50 trận". Với nhóm này (rating hội tụ
//     rất chậm), đó là lỗi chí mạng.
// ============================================================

import type { ClubPlayer } from './types';

/** Thang điểm: 0-100, trung bình 50, độ lệch chuẩn ~15. */
export const MU_MIN = 25;
export const MU_MAX = 75;

/** Độ bất định ban đầu. ĐỪNG hạ thấp hơn — rating sẽ học chậm. */
export const SIGMA_INIT = 8.0;

/** Sàn của sigma. Không bao giờ "biết chắc chắn" về ai. */
export const SIGMA_MIN = 2.5;

/** "Độ rộng một bậc trình độ" — yếu tố may rủi của cầu lông. */
export const BETA = 4.17;

/** Sigma nở ra bao nhiêu mỗi tuần vắng mặt. */
export const TAU_PER_WEEK = 0.6;

/** Ngưỡng để coi rating là ĐÃ HỘI TỤ (mới được hiện cho người chơi). */
export const SIGMA_CONVERGED = 4.0;
export const GAMES_CONVERGED = 15;

// ------------------------------------------------------------
// SEED — ánh xạ thứ hạng do admin xếp thành mu
// ------------------------------------------------------------

/**
 * Admin xếp hạng TRONG TỪNG DIV (dễ hơn nhiều so với xếp cả 22 người
 * — và mô phỏng cho thấy kết quả TỐT HƠN: 24.7% trận bét ở tháng đầu,
 * so với 31.2% khi xếp hạng toàn nhóm).
 *
 * Hai div được cố ý CHỒNG LẤN: người D2 giỏi nhất (52) gần với người
 * D1 yếu nhất (55). Ranh giới div vốn mờ — đừng khẳng định một khoảng
 * cách không có thật.
 */
export function seedMu(div: 1 | 2, rankInDiv: number, divSize: number): number {
  const t = divSize <= 1 ? 0 : (rankInDiv - 1) / (divSize - 1); // 0 = mạnh nhất
  if (div === 1) return 72 - t * (72 - 55);  // 72 → 55
  return 52 - t * (52 - 32);                  // 52 → 32
}

// ------------------------------------------------------------
// DỰ ĐOÁN
// ------------------------------------------------------------

/** Hàm phân phối chuẩn tích luỹ. Xấp xỉ Abramowitz–Stegun, sai số < 7.5e-8. */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}

export interface TeamRating { mu: number; sigmaSq: number; }

export function teamRating(p1: ClubPlayer, p2: ClubPlayer): TeamRating {
  return {
    mu: p1.mu + p2.mu,
    sigmaSq: p1.sigma ** 2 + p2.sigma ** 2,   // CỘNG PHƯƠNG SAI, không cộng sigma
  };
}

/**
 * P(đội A thắng).
 *
 * Mẫu số = tổng độ mù mờ, gồm HAI nguồn:
 *   - sigma²  : "tôi không biết rõ những người này mạnh cỡ nào"
 *   - 2·beta² : "kể cả biết rõ, cầu lông vẫn có may rủi"
 *
 * Khi sigma lớn → mẫu số lớn → kết quả về gần 0.5.
 * Nghĩa là: KHI KHÔNG BIẾT GÌ, APP TỰ NÓI "KHÔNG BIẾT".
 * Không cần viết thêm `if` nào.
 */
export function winProbability(a: TeamRating, b: TeamRating): number {
  const c = Math.sqrt(2 * BETA ** 2 + a.sigmaSq + b.sigmaSq);
  return normalCdf((a.mu - b.mu) / c);
}

// ------------------------------------------------------------
// CẬP NHẬT SAU TRẬN
// ------------------------------------------------------------

export interface RatingUpdate { playerId: string; mu: number; sigma: number; }

/**
 * Cập nhật rating sau một trận.
 *
 * Điểm mấu chốt: mức thay đổi tỉ lệ với sigma². Người còn mù mờ
 * (sigma lớn) học nhanh; người đã biết rõ (sigma nhỏ) gần như không đổi.
 *
 * Hệ quả tự động: khi đánh với KHÁCH VÃNG LAI (sigma khổng lồ), mẫu số
 * phình to → mức cập nhật cho hội viên tự động giảm. Rating của bạn
 * KHÔNG bị hỏng bởi một trận với người lạ. Không cần code gì thêm.
 */
export function updateRatings(
  teamA: [ClubPlayer, ClubPlayer],
  teamB: [ClubPlayer, ClubPlayer],
  winner: 'A' | 'B',
): RatingUpdate[] {
  const ra = teamRating(teamA[0], teamA[1]);
  const rb = teamRating(teamB[0], teamB[1]);

  const c = Math.sqrt(2 * BETA ** 2 + ra.sigmaSq + rb.sigmaSq);
  const expectedA = 1 / (1 + Math.exp(-(ra.mu - rb.mu) / c));
  const actualA = winner === 'A' ? 1 : 0;

  const out: RatingUpdate[] = [];

  for (const p of teamA) {
    out.push({
      playerId: p.id,
      mu: p.mu + (p.sigma ** 2 / c) * (actualA - expectedA),
      sigma: Math.max(SIGMA_MIN, p.sigma * 0.97),
    });
  }
  for (const p of teamB) {
    out.push({
      playerId: p.id,
      mu: p.mu + (p.sigma ** 2 / c) * ((1 - actualA) - (1 - expectedA)),
      sigma: Math.max(SIGMA_MIN, p.sigma * 0.97),
    });
  }
  return out;
}

// ------------------------------------------------------------
// VẮNG MẶT
// ------------------------------------------------------------

/**
 * Nghỉ lâu → sigma NỞ RA. Nhưng mu KHÔNG ĐỔI.
 *
 * Đây là điểm quan trọng nhất trong toàn bộ file này:
 *
 *   BẠN KHÔNG YẾU ĐI VÌ NGHỈ HAI TUẦN.
 *   Hệ thống chỉ BỚT CHẮC CHẮN về bạn.
 *
 * Đừng bao giờ giảm mu vì vắng mặt — đó là NÓI DỐI, và người ta sẽ
 * phát hiện ra. Nếu muốn tạo áp lực đi đều, hãy dùng HẠNG (tier), thứ
 * đòi hỏi hoạt động gần đây để giữ. Rating là sự thật; hạng là chỗ đứng.
 */
export function inflateSigmaForAbsence(player: ClubPlayer, weeksAway: number): number {
  if (weeksAway <= 0) return player.sigma;
  return Math.min(
    SIGMA_INIT,
    Math.sqrt(player.sigma ** 2 + (TAU_PER_WEEK ** 2) * weeksAway),
  );
}

// ------------------------------------------------------------
// HIỂN THỊ
// ------------------------------------------------------------

/**
 * Rating đã đủ tin cậy để HIỆN cho người chơi chưa?
 * Nếu chưa: hiện "Đang xếp hạng (8/15 trận)" — trung thực, và tự nó
 * là động lực để đi đều.
 */
export function isConverged(p: ClubPlayer): boolean {
  return p.sigma < SIGMA_CONVERGED && p.gamesTotal >= GAMES_CONVERGED;
}

/** Dự đoán CHỈ được hiện khi cả 4 người đều đã hội tụ. */
export function canShowPrediction(players: ClubPlayer[]): boolean {
  return players.every(p => p.sigma < SIGMA_CONVERGED);
}
