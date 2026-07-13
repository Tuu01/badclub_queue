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

const KEY = 'appCode';

type Resolver = (code: string | null) => void;
let pendingResolvers: Resolver[] = [];
const listeners = new Set<(open: boolean, retry: boolean) => void>();

export function getCode(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(KEY);
}

export function setCode(code: string): void {
  window.localStorage.setItem(KEY, code);
}

export function clearCode(): void {
  window.localStorage.removeItem(KEY);
}

/** Subscribed to by <CodeModal>. Not for direct use elsewhere. */
export function subscribeCodeModal(fn: (open: boolean, retry: boolean) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function askForCode(retry: boolean): Promise<string | null> {
  return new Promise(resolve => {
    pendingResolvers.push(resolve);
    listeners.forEach(fn => fn(true, retry));
  });
}

/** Called by <CodeModal> when the user submits the form. */
export function submitCode(code: string): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  listeners.forEach(fn => fn(false, false));
  resolvers.forEach(r => r(code));
}

/** Called by <CodeModal> when the user cancels. */
export function cancelCodeEntry(): void {
  const resolvers = pendingResolvers;
  pendingResolvers = [];
  listeners.forEach(fn => fn(false, false));
  resolvers.forEach(r => r(null));
}

/**
 * fetch() for WRITE requests. If there's no code yet, opens the modal
 * and waits for it. If the server returns 401 (wrong code), clears
 * the old code, opens the modal again, and retries once.
 */
export async function writeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let code = getCode();
  if (!code) {
    code = await askForCode(false);
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
    const retry = await askForCode(true);
    if (!retry) return res;
    setCode(retry);
    res = await doFetch(retry);
  }
  return res;
}
