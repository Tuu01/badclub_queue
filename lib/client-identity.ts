'use client';

// ============================================================
// client-identity.ts — "open the app → pick your name → localStorage. Done."
// No accounts. Only used to: (1) highlight "You" in the queue,
// (2) the actor written to the audit log (who tapped what) — NOT used
// for permissions (see lib/auth.ts; the access code is what gates writes).
//
// useSyncExternalStore instead of useState+useEffect: localStorage is a
// real external store (no window on the server), which is the right
// tool for it — not setState inside an effect.
// ============================================================

import { useSyncExternalStore } from 'react';

export interface Actor {
  id: string;
  name: string;
}

const KEY = 'actor';
const listeners = new Set<() => void>();

// useSyncExternalStore requires getSnapshot() to return the SAME
// reference when the underlying data hasn't changed (compared via
// Object.is). JSON.parse() on every call creates a NEW object even
// when the localStorage string is identical → React sees "the
// snapshot keeps changing" → infinite loop ("Maximum update depth
// exceeded"). Cache by the raw string so we return exactly one
// reference when nothing has actually changed.
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

/** Reads the current actor, re-rendering whenever setActor()/clearActor() is called. */
export function useActor(): Actor | null {
  return useSyncExternalStore(subscribe, read, getServerSnapshot);
}
