import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { createSessionRoster } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// /admin/session/new — finalizes courts + the session roster. Does
// NOT check anyone in (that's the job of /api/session/:id/checkin).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtCount, playerIds } = body ?? {};
  if (!Number.isInteger(courtCount) || courtCount < 1 || !Array.isArray(playerIds) || playerIds.length === 0) {
    return NextResponse.json({ error: 'missing valid courtCount/playerIds' }, { status: 400 });
  }

  const result = await createSessionRoster(adminDb, CLUB_ID, { sessionId: id, courtCount, playerIds });
  return NextResponse.json({ ok: true, sessionId: id, ...result });
}
