// ============================================================
// auth.ts — code-based roles, not accounts.
// See PROMPT.md "THREE NON-NEGOTIABLE PRINCIPLES #3" and CLAUDE.md "ROLES".
//
// Three tiers, two secrets:
//   (no code)     → PLAYER   read-only (/board, /me, view live match, pick
//                              self) + pause/un-pause/leave ANYONE — see
//                              CLAUDE.md "ROLES" for why that one is open
//   APP_CODE_MGR  → MANAGER  + check-in, assign, record, swap, mode,
//                              start/end session, add guest
//   APP_CODE_ADM  → ADMIN    + create/edit/delete sessions, CRUD players
//
// The split is REVERSIBILITY, not importance: everything a manager does is
// undoable within the session; admin actions (deleting a session with games
// in it, editing a player) are not. See CLAUDE.md for why there's no login
// screen and no per-person assignment.
// ============================================================

import { NextRequest, NextResponse } from 'next/server';

export type Role = 'PLAYER' | 'MANAGER' | 'ADMIN';

const RANK: Record<Role, number> = { PLAYER: 0, MANAGER: 1, ADMIN: 2 };

function roleForCode(code: string | null): Role {
  if (code && code === process.env.APP_CODE_ADM) return 'ADMIN';
  if (code && code === process.env.APP_CODE_MGR) return 'MANAGER';
  return 'PLAYER';
}

/** The role implied by whatever code (if any) the request is carrying. */
export function getRole(req: NextRequest): Role {
  return roleForCode(req.headers.get('x-app-code'));
}

/**
 * Returns a ready-to-return NextResponse if the request doesn't meet
 * `required`, or null if it's cleared to proceed.
 *
 * No code at all → 401 (the client should prompt for one — they might
 * have one to enter). A code that's valid but not strong enough → 403
 * (re-entering the SAME code again will never fix this — don't prompt).
 */
export function requireRole(req: NextRequest, required: 'MANAGER' | 'ADMIN'): NextResponse | null {
  const code = req.headers.get('x-app-code');
  if (!code) return NextResponse.json({ error: 'code required', requiredRole: required }, { status: 401 });

  const role = roleForCode(code);
  if (RANK[role] >= RANK[required]) return null;
  if (role === 'PLAYER') {
    return NextResponse.json({ error: 'invalid code', requiredRole: required }, { status: 401 });
  }
  return NextResponse.json(
    {
      error: `That code doesn't have access to this. Requires the ${required.toLowerCase()} code.`,
      requiredRole: required,
    },
    { status: 403 },
  );
}
