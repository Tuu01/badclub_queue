// Dựng input cho buildQueue() (lõi thuần, lib/matchmaking.ts) TRỰC TIẾP
// TRÊN CLIENT, từ session doc đã có sẵn qua onSnapshot. Không gọi API
// riêng — và thứ tự hiển thị LUÔN khớp với tầng 1 (cổng) thật của server.
//
// `SessionDoc` chỉ import KIỂU (import type) — bị xoá lúc build, nên
// firebase-admin (chỉ dùng ở server) không lọt vào bundle client.

import { buildQueue } from './matchmaking';
import { DEFAULT_CONFIG, type ClubPlayer, type Attendance, type PlayerId } from './types';
import type { SessionDoc } from './firestore';

export function computeQueue(session: SessionDoc, now: number) {
  // Firestore KHÔNG giữ nguyên thứ tự field qua các lần update dot-path
  // (vd. setPaused) — sắp theo id trước khi đưa vào Map để tầng 3 (bốc
  // thăm cố định rng=0) cho thứ tự ỔN ĐỊNH giữa các lần render, thay vì
  // nhảy lung tung theo thứ tự field ngẫu nhiên Firestore trả về.
  const ids = Object.keys(session.players).sort();

  const players = new Map<PlayerId, ClubPlayer>();
  for (const id of ids) {
    const p = session.players[id];
    players.set(id, { ...p, seedRank: 0, gamesTotal: 0, lastPlayedAt: null, isGuest: false, active: true });
  }

  const attendance = new Map<PlayerId, Attendance>();
  for (const id of ids) {
    const a = session.attendance[id];
    if (a) attendance.set(id, { playerId: id, ...a });
  }

  const busy = new Set<PlayerId>();
  for (const c of session.courts) {
    if (c.players) for (const id of c.players) busy.add(id);
  }

  // rng cố định — đây chỉ là hàng chờ HIỂN THỊ, cố định để không nhấp
  // nháy thứ tự giữa các lần render khi hoà tuyệt đối (đầu buổi).
  return buildQueue({ now, players, attendance, pairStats: {}, config: DEFAULT_CONFIG, busy, rng: () => 0 });
}
