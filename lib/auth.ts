// ============================================================
// auth.ts — no accounts, no roles. One shared code.
// See PROMPT.md "THREE NON-NEGOTIABLE PRINCIPLES #3".
// ============================================================

import { NextRequest } from 'next/server';

/** true if the request carries the correct code in the `x-app-code` header. */
export function hasValidCode(req: NextRequest): boolean {
  const code = req.headers.get('x-app-code');
  return !!code && code === process.env.APP_CODE;
}
