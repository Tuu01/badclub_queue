'use client';

// ============================================================
// client-role.ts — "which of the two codes (if any) is this browser
// carrying, and what does that unlock?"
//
// The client can never verify a code itself (APP_CODE_MGR/APP_CODE_ADM
// are server-only env vars) — it asks GET /api/role and caches the
// answer in localStorage alongside the code, refreshed on every
// setCode()/clearCode(). Same useSyncExternalStore pattern as
// client-identity.ts, for the same reason: localStorage is a real
// external store, not something to setState from inside an effect.
//
// This is a UI convenience only, never trusted for permission — every
// write route re-checks the real code server-side via lib/auth.ts.
// ============================================================

import { useSyncExternalStore } from 'react';

export type Role = 'PLAYER' | 'MANAGER' | 'ADMIN';

const KEY = 'appRole';
const listeners = new Set<() => void>();

function isRole(v: string | null): v is Role {
  return v === 'PLAYER' || v === 'MANAGER' || v === 'ADMIN';
}

function read(): Role {
  if (typeof window === 'undefined') return 'PLAYER';
  const raw = window.localStorage.getItem(KEY);
  return isRole(raw) ? raw : 'PLAYER';
}

export function getCachedRole(): Role {
  return read();
}

function setCachedRole(role: Role): void {
  window.localStorage.setItem(KEY, role);
  listeners.forEach(l => l());
}

export function clearCachedRole(): void {
  window.localStorage.removeItem(KEY);
  listeners.forEach(l => l());
}

/**
 * Asks the server what the currently-stored code is worth and caches
 * the answer. Call this right after setCode()/clearCode() so the UI's
 * hide/show state stays in sync with the code actually held.
 */
export async function refreshRole(): Promise<Role> {
  if (typeof window === 'undefined') return 'PLAYER';
  const code = window.localStorage.getItem('appCode');
  try {
    const res = await fetch('/api/role', { headers: code ? { 'x-app-code': code } : {} });
    const body = await res.json().catch(() => null);
    const role: Role = isRole(body?.role) ? body.role : 'PLAYER';
    setCachedRole(role);
    return role;
  } catch {
    clearCachedRole();
    return 'PLAYER';
  }
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

function getServerSnapshot(): Role {
  return 'PLAYER';
}

/** Re-renders whenever refreshRole()/clearCachedRole() changes the cached role. */
export function useRole(): Role {
  return useSyncExternalStore(subscribe, read, getServerSnapshot);
}
