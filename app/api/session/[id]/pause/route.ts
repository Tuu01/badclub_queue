import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setPaused } from '@/lib/firestore';

// Deliberately PLAYER-tier — no code required. See CLAUDE.md "ROLES": the
// person who sees a court free up is whoever's sitting out, not whoever
// holds the manager code. Reversible in one tap either way.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { playerId, paused } = body ?? {};
  if (typeof playerId !== 'string' || typeof paused !== 'boolean') {
    return NextResponse.json({ error: 'missing valid playerId/paused' }, { status: 400 });
  }

  await setPaused(adminDb, id, playerId, paused);
  return NextResponse.json({ ok: true });
}
