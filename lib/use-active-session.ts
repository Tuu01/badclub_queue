'use client';

// Reads directly via the client SDK (onSnapshot) — never through Vercel.
// sessions/{sid} allows open reads (firestore.rules), and that also
// covers collection-level list queries against `sessions`.
//
// getActiveSession():
//   1. a session with status = LIVE, dated today or later  → return it
//   2. else the nearest DRAFT with date >= today            → return it
//   3. else null
//
// UC-12 (USECASES.md): "the session never ends." Nobody taps [End
// session] on the way out of the hall — that's a fact about people,
// not a bug to fix with a better button. So a LIVE session dated
// BEFORE today is treated as stale and skipped right here, on every
// read, by every client. No cron job, no scheduled function, no
// write-back to Firestore (the doc's status field is left alone —
// this is a display-time resolution rule, not a state transition).
// Caught this shadowing my own testing twice while building today's
// other fixes, using a session date-stamped days in the past.

import { useEffect, useState } from 'react';
import { collection, onSnapshot, query, where } from 'firebase/firestore';
import { db } from './firebase-client';
import { todayDateString } from './session-id';
import type { SessionDoc } from './firestore';

export function useActiveSession(): {
  session: SessionDoc | null;
  loading: boolean;
  lastUpdateAt: number | null;
} {
  const [live, setLive] = useState<SessionDoc | null | undefined>(undefined);
  const [nearestDraft, setNearestDraft] = useState<SessionDoc | null | undefined>(undefined);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);

  useEffect(() => {
    const liveQuery = query(collection(db, 'sessions'), where('status', '==', 'LIVE'));
    const unsubLive = onSnapshot(liveQuery, snap => {
      const today = todayDateString();
      const current = snap.docs
        .map(d => d.data() as SessionDoc)
        .filter(s => s.date >= today);   // stale LIVE (date < today) → never resurrects
      setLive(current.length > 0 ? current[0] : null);
      setLastUpdateAt(Date.now());
    });

    const today = todayDateString();
    const draftQuery = query(collection(db, 'sessions'), where('status', '==', 'DRAFT'));
    const unsubDraft = onSnapshot(draftQuery, snap => {
      const upcoming = snap.docs
        .map(d => d.data() as SessionDoc)
        .filter(s => s.date >= today)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setNearestDraft(upcoming.length > 0 ? upcoming[0] : null);
      setLastUpdateAt(Date.now());
    });

    return () => {
      unsubLive();
      unsubDraft();
    };
  }, []);

  const loading = live === undefined || nearestDraft === undefined;
  const session = live ?? nearestDraft ?? null;

  return { session, loading, lastUpdateAt };
}
