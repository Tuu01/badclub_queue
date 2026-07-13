import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { startSession, AlreadyLiveError } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';

function formatPlayDate(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short' });
}

// / — admin taps "Start session" on a DRAFT to make it LIVE. Refuses
// if another session is already LIVE — see AlreadyLiveError in
// lib/firestore.ts.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  try {
    await startSession(adminDb, id);
    return NextResponse.json({ ok: true, sessionId: id });
  } catch (err) {
    if (err instanceof AlreadyLiveError) {
      return NextResponse.json(
        { error: `A session is already live (${formatPlayDate(err.liveDate)}). End it first.` },
        { status: 409 },
      );
    }
    throw err;
  }
}
