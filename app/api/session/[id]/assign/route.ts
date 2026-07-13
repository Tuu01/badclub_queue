import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { assignCourt, ConflictError } from '@/lib/firestore';
import { hasValidCode } from '@/lib/auth';
import type { PlayerId } from '@/lib/types';

// Used for both manual court assignment (RECORD mode, "Start court")
// and suggestion-based assignment (ASSIGN mode, Step 5) — the client
// always sends four/teamA/teamB, and the server always re-validates
// inside the transaction. See ARCHITECTURE.md §3.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!hasValidCode(req)) {
    return NextResponse.json({ error: 'invalid code' }, { status: 401 });
  }

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtIdx, four, teamA, teamB, predictedProbA, accepted, suggested, reason, assignedByApp, actor } = body ?? {};

  if (
    !Number.isInteger(courtIdx) ||
    !Array.isArray(four) || four.length !== 4 ||
    !Array.isArray(teamA) || teamA.length !== 2 ||
    !Array.isArray(teamB) || teamB.length !== 2 ||
    typeof actor !== 'string'
  ) {
    return NextResponse.json({ error: 'missing valid courtIdx/four/teamA/teamB/actor' }, { status: 400 });
  }

  try {
    const result = await assignCourt(adminDb, id, {
      courtIdx,
      four: four as [PlayerId, PlayerId, PlayerId, PlayerId],
      teamA: teamA as [PlayerId, PlayerId],
      teamB: teamB as [PlayerId, PlayerId],
      predictedProbA: typeof predictedProbA === 'number' ? predictedProbA : null,
      accepted: !!accepted,
      suggested: Array.isArray(suggested) ? suggested : undefined,
      reason: typeof reason === 'string' ? reason : undefined,
      assignedByApp: !!assignedByApp,
      actor,
    });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Normal — two courts grabbed the same person at once. Not an error.
      return NextResponse.json({ error: 'already taken', taken: err.taken }, { status: 409 });
    }
    throw err;
  }
}
