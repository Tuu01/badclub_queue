'use client';

// ============================================================
// client-identity.ts — "mở app → chọn tên → localStorage. Xong."
// Không tài khoản. Chỉ để: (1) tô đậm "Bạn" trong hàng chờ,
// (2) actor ghi vào audit log (ai bấm gì) — KHÔNG dùng để phân quyền
// (xem lib/auth.ts, mã vào cửa mới là thứ gác quyền ghi).
//
// useSyncExternalStore thay vì useState+useEffect: localStorage là một
// external store thật (SSR không có window), đây là đúng công cụ cho nó
// — không phải setState trong effect.
// ============================================================

import { useSyncExternalStore } from 'react';

export interface Actor {
  id: string;
  name: string;
}

const KEY = 'actor';
const listeners = new Set<() => void>();

// useSyncExternalStore đòi getSnapshot() trả về CÙNG reference nếu dữ
// liệu chưa đổi (so sánh bằng Object.is). JSON.parse() mỗi lần gọi tạo
// object MỚI dù chuỗi localStorage giống hệt → React thấy "snapshot đổi
// liên tục" → lặp vô hạn ("Maximum update depth exceeded"). Cache theo
// chuỗi thô để trả về đúng 1 reference khi chưa có gì thay đổi.
let cachedRaw: string | null | undefined;
let cachedActor: Actor | null = null;

function read(): Actor | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(KEY);
  if (raw === cachedRaw) return cachedActor;
  cachedRaw = raw;
  if (!raw) {
    cachedActor = null;
    return null;
  }
  try {
    cachedActor = JSON.parse(raw) as Actor;
  } catch {
    cachedActor = null;
  }
  return cachedActor;
}

export function getActor(): Actor | null {
  return read();
}

export function setActor(actor: Actor): void {
  window.localStorage.setItem(KEY, JSON.stringify(actor));
  listeners.forEach(l => l());
}

export function clearActor(): void {
  window.localStorage.removeItem(KEY);
  listeners.forEach(l => l());
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getServerSnapshot(): Actor | null {
  return null;
}

/** Đọc actor hiện tại, tự re-render khi setActor()/clearActor() được gọi. */
export function useActor(): Actor | null {
  return useSyncExternalStore(subscribe, read, getServerSnapshot);
}
