import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { swapPlayerOnCourt, SwapError, ConflictError } from '@/lib/firestore';
import { requireRole } from '@/lib/auth';

// Replace one player on a court that's ALREADY IN PLAY, same slot, no
// team rebalance. See USECASES.md UC-1 and lib/firestore.ts#swapPlayerOnCourt.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const roleErr = requireRole(req, 'MANAGER');
  if (roleErr) return roleErr;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const { courtIdx, outId, inId, actor } = body ?? {};
  if (
    !Number.isInteger(courtIdx) ||
    typeof outId !== 'string' || typeof inId !== 'string' || typeof actor !== 'string'
  ) {
    return NextResponse.json({ error: 'missing valid courtIdx/outId/inId/actor' }, { status: 400 });
  }

  try {
    const result = await swapPlayerOnCourt(adminDb, id, { courtIdx, outId, inId, actor });
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof ConflictError) {
      // Normal — inId was just grabbed elsewhere between the client's
      // read and this commit. Not an error the user needs to see.
      return NextResponse.json({ error: 'already taken', taken: err.taken }, { status: 409 });
    }
    if (err instanceof SwapError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}
