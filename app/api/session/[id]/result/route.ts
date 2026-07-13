import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { recordResult } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Idempotent by gameId — three people all tapping "Team A won" all
// get 200 OK. See lib/firestore.ts#recordResult.
//
// winner may be null — UC-7 (USECASES.md): frees the court without
// knowing who won, so a forgotten result never freezes a court.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { gameId, courtIdx, winner, scoreLoser, actor } = body ?? {};
  if (
    typeof gameId !== 'string' || !Number.isInteger(courtIdx) ||
    (winner !== 'A' && winner !== 'B' && winner !== null) || typeof actor !== 'string'
  ) {
    return NextResponse.json({ error: 'missing valid gameId/courtIdx/winner/actor' }, { status: 400 });
  }

  const result = await recordResult(adminDb, id, CLUB_ID, {
    gameId, courtIdx, winner,
    scoreLoser: typeof scoreLoser === 'number' ? scoreLoser : undefined,
    actor,
  });
  return NextResponse.json(result);
}
