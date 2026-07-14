import { NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getBoardData } from '@/lib/firestore';
import { CLUB_ID } from '@/lib/constants';

// PLAYER-tier — no code required. /board and /me are the PLAYER
// surface (view-only), same as viewing the live match on `/`.
export async function GET() {
  const data = await getBoardData(adminDb, CLUB_ID);
  return NextResponse.json(data);
}
