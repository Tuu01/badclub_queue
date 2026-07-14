import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setDraftRoster, deleteDraftSession, NotDraftError } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';
import { CLUB_ID } from '@/lib/constants';

// Edit a DRAFT's roster/court count in place. Refuses (409) if the
// session has already gone LIVE — see lib/firestore.ts#setDraftRoster.
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtCount, playerIds } = body ?? {};
  if (!Number.isInteger(courtCount) || courtCount < 1 || !Array.isArray(playerIds) || playerIds.length === 0) {
    return NextResponse.json({ error: 'missing valid courtCount/playerIds' }, { status: 400 });
  }

  try {
    await setDraftRoster(adminDb, CLUB_ID, id, { courtCount, playerIds });
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NotDraftError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}

// Delete a DRAFT outright — used to fix a wrong PLAY DATE (the date is
// the document id, so there's no rename; delete the wrong one, create
// a fresh one at the correct date).
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'ADMIN');
  if (roleErr) return roleErr;

  const { id } = await params;
  try {
    await deleteDraftSession(adminDb, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof NotDraftError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }
}
