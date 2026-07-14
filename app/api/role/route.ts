import { NextRequest, NextResponse } from 'next/server';
import { getRole } from '@/lib/auth';

// Read-only: tells the client which role its stored code implies, so the
// UI can hide (not grey out) actions it can't perform. The code itself
// never leaves the client differently than it arrived — this endpoint
// only echoes back what the code is worth, which isn't sensitive since
// the caller already had to possess the code to ask.
export async function GET(req: NextRequest) {
  return NextResponse.json({ role: getRole(req) });
}
