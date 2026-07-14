import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { endSession, getSessionSummary, NotLiveError } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Admin-initiated end from /admin/sessions. See lib/firestore.ts#endSession
// for why this is separate from UC-12's automatic staleness check.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'MANAGER');
  if (roleErr) return roleErr;

  const { id } = await params;
  try {
    await endSession(adminDb, CLUB_ID, id);
    // F-2 — the copyable post-session summary. Computed fresh right
    // after ending, not stored, since it's cheap and only ever shown once.
    const summary = await getSessionSummary(adminDb, CLUB_ID, id);
    return NextResponse.json({ ok: true, summary });
  } catch (err) {
    if (err instanceof NotLiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
