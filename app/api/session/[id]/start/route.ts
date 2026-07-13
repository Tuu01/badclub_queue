import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { startSession } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

// / — admin taps "Start session" on a DRAFT to make it LIVE.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  await startSession(adminDb, id);
  return NextResponse.json({ ok: true, sessionId: id });
}
