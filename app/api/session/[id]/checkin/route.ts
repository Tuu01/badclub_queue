import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { checkInForToday } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Bản tối giản: /checkin vừa tạo session (nếu chưa có) vừa check-in,
// không qua /admin/session/new riêng. Xem lib/firestore.ts#checkInForToday.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtCount, playerIds } = body ?? {};
  if (!Number.isInteger(courtCount) || courtCount < 1 || !Array.isArray(playerIds) || playerIds.length === 0) {
    return NextResponse.json({ error: 'thiếu courtCount/playerIds hợp lệ' }, { status: 400 });
  }

  await checkInForToday(adminDb, CLUB_ID, { sessionId: id, courtCount, playerIds });
  return NextResponse.json({ ok: true, sessionId: id });
}
