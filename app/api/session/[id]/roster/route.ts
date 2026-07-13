import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { createSessionRoster, SessionExistsError } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// /admin/session/new — finalizes courts + the session roster for a
// NEW session. Does NOT check anyone in (that's /api/session/:id/checkin).
// Refuses (409) if a session already exists for this date, in any
// status — editing an existing DRAFT on purpose goes through
// /api/session/:id/draft instead. See SessionExistsError.
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

  try {
    const result = await createSessionRoster(adminDb, CLUB_ID, { sessionId: id, courtCount, playerIds });
    return NextResponse.json({ ok: true, sessionId: id, ...result });
  } catch (err) {
    if (err instanceof SessionExistsError) {
      return NextResponse.json(
        { error: `A session already exists for ${id}. Pick a different date, or edit the existing one from /admin.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
