'use client';

// ============================================================
// client-code.ts — "no accounts, no roles, one shared code"
// Enter the code once → localStorage → attached to every WRITE request.
//
// Uses an in-page modal (see CodeModal component) instead of
// window.prompt() — prompt()/confirm()/alert() are blocked in many
// embedded browser contexts (iframes, webviews, some mobile/PWA
// shells), which would otherwise silently break every write action.
// ============================================================

import { refreshRole, clearCachedRole } from './client-role';

const KEY = 'appCode';

const MSG_INITIAL = 'Enter the group access code:';
const MSG_WRONG = 'Wrong code. Try again:';

type Resolver = (code: string | null) => void;
let pendingResolvers: Resolver[] = [];
const listeners = new Set<(open: boolean, message: string) => void>();

export function getCode(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}

export function setCode(code: string): void {
  window.localStorage.setItem(KEY, code);
  void refreshRole();
}

export function clearCode(): void {
  window.localStorage.removeItem(KEY);
  clearCachedRole();
}

/** Subscribed to by <CodeModal>. Not for direct use elsewhere. */
export function subscribeCodeModal(fn: (open: boolean, message: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function askForCode(message: string): Promise<string | null> {
  return new Promise(resolve => {
    pendingResolvers.push(resolve);
    listeners.forEach(fn => fn(true, message));
  });
}

/** Called by <CodeModal> when the user submits the form. */
export function submitCode(code: string): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  listeners.forEach(fn => fn(false, ''));
  resolvers.forEach(r => r(code));
}

/** Called by <CodeModal> when the user cancels. */
export function cancelCodeEntry(): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  listeners.forEach(fn => fn(false, ''));
  resolvers.forEach(r => r(null));
}

/**
 * Opens the code modal directly, outside of any write attempt — for the
 * "Enter code" affordance shown to a PLAYER so they can become a
 * MANAGER/ADMIN without first tapping a button they can't press.
 */
export async function enterCode(): Promise<void> {
  const code = await askForCode(MSG_INITIAL);
  if (code) setCode(code);
}

/**
 * fetch() for WRITE requests.
 *  - No code yet → opens the modal and waits.
 *  - 401 (missing/wrong code) → clears it, re-prompts, retries once.
 *  - 403 (a real code, just not a strong enough one) → never a dead
 *    end: says which code it actually needs and offers to enter it,
 *    then retries with whatever was typed.
 */
export async function writeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let code = getCode();
  if (!code) {
    code = await askForCode(MSG_INITIAL);
    if (!code) throw new Error('code required to write');
    setCode(code);
  }

  const doFetch = (c: string) =>
    fetch(input, {
      ...init,
      headers: { ...(init.headers ?? {}), 'x-app-code': c, 'content-type': 'application/json' },
    });

  let res = await doFetch(code);

  if (res.status === 401) {
    clearCode();
    const retry = await askForCode(MSG_WRONG);
    if (!retry) return res;
    setCode(retry);
    res = await doFetch(retry);
  } else if (res.status === 403) {
    const body = await res.clone().json().catch(() => null);
    const needs = body?.requiredRole === 'ADMIN' ? 'admin' : 'manager';
    const upgrade = await askForCode(`This needs the ${needs} code:`);
    if (!upgrade) return res;
    setCode(upgrade);
    res = await doFetch(upgrade);
  }

  return res;
}
