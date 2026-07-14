import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getTournamentView } from '@/lib/tournament';
import type { PublicPlayerDoc } from '@/lib/firestore';
import { CLUB_ID } from '@/lib/constants';

// PLAYER-tier — view-only, public read (same as /board). Winrates are
// computed on read inside getTournamentView. Adds an id→name map so the
// client can render without a second round-trip.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ tid: string }> }) {
  const { tid } = await params;
  const view = await getTournamentView(adminDb, tid);
  if (!view) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const names: Record<string, string> = {};
  const playersSnap = await adminDb.collection(`clubs/${CLUB_ID}/players`).get();
  for (const d of playersSnap.docs) {
    const p = d.data() as PublicPlayerDoc;
    names[p.id] = p.name;
  }
  return NextResponse.json({ ...view, names });
}
