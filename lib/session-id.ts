/** Session hôm nay: id = ngày local (YYYY-MM-DD). Một buổi/ngày là đủ cho CLB này. */
export function todaySessionId(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
