import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { endSession, NotLiveError } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Admin-initiated end from /admin/sessions. See lib/firestore.ts#endSession
// for why this is separate from UC-12's automatic staleness check.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  try {
    await endSession(adminDb, CLUB_ID, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NotLiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
