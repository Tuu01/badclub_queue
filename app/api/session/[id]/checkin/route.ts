import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { checkInBatch } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// The session must already exist (created via /admin/session/new) —
// /checkin only checks people in, it never creates a session.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { playerIds } = body ?? {};
  if (!Array.isArray(playerIds) || playerIds.length === 0) {
    return NextResponse.json({ error: 'missing valid playerIds' }, { status: 400 });
  }

  await checkInBatch(adminDb, id, CLUB_ID, playerIds);
  return NextResponse.json({ ok: true, sessionId: id });
}
