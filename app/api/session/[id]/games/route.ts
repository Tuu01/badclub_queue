import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getGameHistory } from '@/lib/firestore';

// PLAYER-tier — no code required (view-only, same as the live courts).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const history = await getGameHistory(adminDb, id);
  return NextResponse.json({ history });
}
