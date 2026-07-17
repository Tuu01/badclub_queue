import { NextRequest, NextResponse } from 'next/server';
import { adminDb } from '@/lib/firebase-admin';
import { CLUB_ID } from '@/lib/constants';
import { getPhotos, setPhoto, clearPhoto } from '@/lib/firestore';

// Self-serve avatars — PLAYER-tier (no code), same trust model as
// pause/leave. The guards below keep this open endpoint from being abused
// for junk writes: a small size cap and a strict image-data-URI check.
// setPhoto also refuses ids that aren't real roster members.
const MAX_THUMB_CHARS = 25_000; // a 96px JPEG thumbnail is ~4–8 KB
const IMAGE_DATA_URI = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;

export async function GET() {
  const photos = await getPhotos(adminDb, CLUB_ID);
  return NextResponse.json({ photos });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { playerId, thumb } = body ?? {};
  if (typeof playerId !== 'string' || typeof thumb !== 'string') {
    return NextResponse.json({ error: 'missing playerId/thumb' }, { status: 400 });
  }
  if (thumb.length > MAX_THUMB_CHARS) {
    return NextResponse.json({ error: 'image too large' }, { status: 413 });
  }
  if (!IMAGE_DATA_URI.test(thumb)) {
    return NextResponse.json({ error: 'not an image' }, { status: 400 });
  }
  try {
    await setPhoto(adminDb, CLUB_ID, playerId, thumb);
  } catch {
    return NextResponse.json({ error: 'unknown player' }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const { playerId } = body ?? {};
  if (typeof playerId !== 'string') {
    return NextResponse.json({ error: 'missing playerId' }, { status: 400 });
  }
  await clearPhoto(adminDb, CLUB_ID, playerId);
  return NextResponse.json({ ok: true });
}
