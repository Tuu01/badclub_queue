import type { SessionSummary } from './firestore';

// F-2 — deliberately NOT using toLocaleDateString: 'en-US' orders "Jul 19",
// the mockup (and Zalo, where this gets pasted) wants "19 Jul". Hand-rolled
// avoids any locale ambiguity. Shared by every screen that can end a
// session (app/page.tsx, app/admin/sessions/page.tsx) so the format can't
// drift between them.
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatSummaryDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return `${WEEKDAYS[new Date(y, m - 1, d).getDay()]} ${d} ${MONTHS[m - 1]}`;
}

/** Plain text, no markdown — this gets pasted straight into Zalo. */
export function formatSummaryText(s: SessionSummary, boardUrl: string): string {
  const lines: string[] = [];
  lines.push(
    `Badminton · ${formatSummaryDate(s.date)} · ${s.presentCount} people, ${s.matchCount} match${s.matchCount === 1 ? '' : 'es'}`,
  );
  lines.push('');
  if (s.mostMixed) {
    lines.push(`🤝 Most mixed: ${s.mostMixed.name} — ${s.mostMixed.partners} different partner${s.mostMixed.partners === 1 ? '' : 's'}`);
  }
  if (s.longestStreak) {
    lines.push(`🔥 Longest streak: ${s.longestStreak.name} — ${s.longestStreak.streak} session${s.longestStreak.streak === 1 ? '' : 's'} in a row`);
  }
  if (s.firstTimePairNames.length > 0) {
    lines.push(`🆕 First-time pairs: ${s.firstTimePairNames.join(', ')}`);
  }
  lines.push('');
  lines.push(`→ ${boardUrl}`);
  return lines.join('\n');
}
