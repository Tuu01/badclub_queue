import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { rebuildClubState } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// "Recalculate everything" — ADMIN only. Replays every non-VOID session
// from seed and writes back mu/sigma/gamesTotal/pairStats. Idempotent
// and deterministic, so it's safe to run any time; it's how a VOIDed
// game (UC-2) or a changed rating formula propagates through history.
// dryRun: false → this actually writes.
export async function POST(req: NextRequest) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const res = await rebuildClubState(adminDb, CLUB_ID, { dryRun: false });
  return NextResponse.json({
    replayedGames: res.replayedGames,
    replayedSessions: res.replayedSessions.length,
    warnings: res.warnings,
  });
}
