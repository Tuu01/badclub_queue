import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setLeft } from '@/lib/firestore';

// Deliberately PLAYER-tier — no code required. Anyone can tap anyone →
// LEFT. No permission, no confirmation — see USECASES.md UC-13 and
// CLAUDE.md "ROLES". gamesToday is preserved by setLeft(), not reset.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { playerId } = body ?? {};
  if (typeof playerId !== 'string') {
    return NextResponse.json({ error: 'missing valid playerId' }, { status: 400 });
  }

  await setLeft(adminDb, id, playerId);
  return NextResponse.json({ ok: true });
}
