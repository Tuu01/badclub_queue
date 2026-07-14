import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setGameScore } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';

// UC-21 — attaches the score to an ALREADY-recorded game. This is a
// SECOND write, separate from /result: it must never re-trigger the
// rating update, which already happened when the winner was tapped.
// See lib/firestore.ts#setGameScore. Optional, same permission as
// recording the winner (MANAGER) — nobody is blocked by not having it.
//
// Winner's score defaults to 21 in the UI but isn't always 21 (deuce
// games run to 30) — both scores are real inputs, not one fixed label.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'MANAGER');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { gameId, scoreWinner, scoreLoser } = body ?? {};
  if (
    typeof gameId !== 'string' ||
    !Number.isInteger(scoreWinner) || scoreWinner < 21 || scoreWinner > 30 ||
    !Number.isInteger(scoreLoser) || scoreLoser < 0 || scoreLoser > 29 ||
    scoreLoser >= scoreWinner
  ) {
    return NextResponse.json(
      { error: 'missing valid gameId/scoreWinner (21-30)/scoreLoser (0-29, less than scoreWinner)' },
      { status: 400 },
    );
  }

  const result = await setGameScore(adminDb, id, gameId, { scoreWinner, scoreLoser });
  return NextResponse.json(result);
}
