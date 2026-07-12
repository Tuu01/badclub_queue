// ============================================================
// fuzzy-match.ts — dán danh sách từ Zalo, ghép mờ vào 55 người.
// "Nếu chỉ xây MỘT tính năng ở màn này, xây cái này." — PROMPT.md
// ============================================================

function normalizeVN(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

export interface RosterPerson {
  id: string;
  name: string;
}

export interface MatchCandidate {
  id: string;
  name: string;
  distance: number;
}

export interface MatchedLine {
  raw: string;
  best: MatchCandidate | null;
  alternatives: MatchCandidate[];
}

/** Mỗi dòng (hoặc mục phân tách bởi dấu phẩy) trong `pasted` → gợi ý khớp tốt nhất trong roster. */
export function matchPastedNames(pasted: string, roster: RosterPerson[]): MatchedLine[] {
  const lines = pasted
    .split(/[\n,]/)
    .map(s => s.trim())
    .filter(Boolean);

  const normRoster = roster.map(p => ({ ...p, norm: normalizeVN(p.name) }));

  return lines.map(raw => {
    const normRaw = normalizeVN(raw);
    const scored = normRoster
      .map(p => ({ id: p.id, name: p.name, distance: levenshtein(normRaw, p.norm) }))
      .sort((a, b) => a.distance - b.distance);
    const best = scored[0] ?? null;
    // Ngưỡng nới theo độ dài tên — tên ngắn cần khớp chặt hơn.
    const threshold = Math.max(1, Math.floor(normRaw.length * 0.3));
    return {
      raw,
      best: best && best.distance <= threshold ? best : null,
      alternatives: scored.slice(0, 5),
    };
  });
}
