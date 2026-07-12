import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { recordResult } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Idempotent theo gameId — ba người cùng bấm "Đội A thắng" đều 200 OK.
// Xem lib/firestore.ts#recordResult.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { gameId, courtIdx, winner, scoreLoser, actor } = body ?? {};
  if (
    typeof gameId !== 'string' || !Number.isInteger(courtIdx) ||
    (winner !== 'A' && winner !== 'B') || typeof actor !== 'string'
  ) {
    return NextResponse.json({ error: 'thiếu gameId/courtIdx/winner/actor hợp lệ' }, { status: 400 });
  }

  const result = await recordResult(adminDb, id, CLUB_ID, {
    gameId, courtIdx, winner,
    scoreLoser: typeof scoreLoser === 'number' ? scoreLoser : undefined,
    actor,
  });
  return NextResponse.json(result);
}
