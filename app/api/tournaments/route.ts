import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { listTournaments } from '@/lib/tournament';

// PLAYER-tier — view-only. Lightweight list for the admin hub + discovery.
export async function GET() {
  const list = (await listTournaments(adminDb)).map(t => ({
    id: t.id, name: t.name, date: t.date, status: t.status,
    teamsFinalized: t.teamsFinalized, imported: t.imported, courtCount: t.courtCount,
  }));
  return NextResponse.json({ tournaments: list });
}
