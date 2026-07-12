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

function read(): Actor | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Actor;
  } catch {
    return null;
  }
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
