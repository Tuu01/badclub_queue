import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { setPaused } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'sai mã' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { playerId, paused } = body ?? {};
  if (typeof playerId !== 'string' || typeof paused !== 'boolean') {
    return NextResponse.json({ error: 'thiếu playerId/paused hợp lệ' }, { status: 400 });
  }

  await setPaused(adminDb, id, playerId, paused);
  return NextResponse.json({ ok: true });
}
