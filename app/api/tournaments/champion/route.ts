import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getLatestChampion } from '@/lib/tournament';
import type { PublicPlayerDoc } from '@/lib/firestore';
import { CLUB_ID } from '@/lib/constants';

// PLAYER-tier — view-only. The most recent completed tournament's
// champion team, for the /board glory showcase. Resolves member names.
export async function GET() {
  const champ = await getLatestChampion(adminDb);
  if (!champ) return NextResponse.json({ champion: null });

  const names: Record<string, string> = {};
  for (const d of (await adminDb.collection(`clubs/${CLUB_ID}/players`).get()).docs) {
    const p = d.data() as PublicPlayerDoc;
    names[p.id] = p.name;
  }
  return NextResponse.json({
    champion: { ...champ, memberNames: champ.memberIds.map(id => names[id] ?? id) },
  });
}
