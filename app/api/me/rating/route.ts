import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { CLUB_ID } from '@/lib/constants';
import { getPlayerRating } from '@/lib/firestore';

// PLAYER-tier — a player's OWN provisional rating, sent only to them via
// ?playerId=<id>. Nobody else's raw number is exposed here (the public
// board still shows bands only). See getPlayerRating for the owner-decision
// note. Display scale: mu × 20, so the seed average (50) reads as 1000.
export async function GET(req: NextRequest) {
  const playerId = req.nextUrl.searchParams.get('playerId');
  if (!playerId) return NextResponse.json({ rating: null });

  const r = await getPlayerRating(adminDb, CLUB_ID, playerId);
  if (!r) return NextResponse.json({ rating: null });

  return NextResponse.json({
    rating: {
      number: Math.round(r.mu * 20),
      provisional: !r.converged,
      gamesTotal: r.gamesTotal,
    },
  });
}
