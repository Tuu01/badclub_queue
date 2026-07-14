import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getPlayerTrophies } from '@/lib/tournament';

// PLAYER-tier — view-only. ?playerId=<id> → the tournaments that player
// took part in, newest first, each flagged champion or not. Computed on
// read from the games. Permanent — never expires, never decays.
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get('playerId');
  if (!playerId) return NextResponse.json({ trophies: [] });
  const trophies = await getPlayerTrophies(adminDb, playerId);
  return NextResponse.json({ trophies });
}
