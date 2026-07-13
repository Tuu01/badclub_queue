import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setLeft } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

// Anyone can tap anyone → LEFT. No permission, no confirmation — see
// USECASES.md UC-13. gamesToday is preserved by setLeft(), not reset.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { playerId } = body ?? {};
  if (typeof playerId !== 'string') {
    return NextResponse.json({ error: 'missing valid playerId' }, { status: 400 });
  }

  await setLeft(adminDb, id, playerId);
  return NextResponse.json({ ok: true });
}
