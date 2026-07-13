import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { getSuggestion } from '@/lib/firestore';
import { CLUB_ID } from '@/lib/constants';

// NOT code-gated — a suggestion + its reason sentence must be
// "visible to anyone" just like the queue (see PROMPT.md "Read: wide
// open"). It goes through Vercel not because it needs the code, but
// because suggestMatch() needs pairStats — private data the client
// can't read directly (firestore.rules).
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const court = req.nextUrl.searchParams.get('court');
  if (court === null || Number.isNaN(Number(court))) {
    return NextResponse.json({ error: 'missing valid ?court=N' }, { status: 400 });
  }

  // suggestMatch() doesn't need to know which court number — a
  // suggestion locks nobody, see ARCHITECTURE.md §5. `court` is only
  // so the client knows which box to attach it to.
  const suggestion = await getSuggestion(adminDb, id, CLUB_ID);
  return NextResponse.json({ suggestion });
}
