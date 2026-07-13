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
  /**
   * True once BOTH listeners are confirmed synced with the server
   * (Firestore's own metadata.fromCache === false) — NOT "changed
   * recently." A plain onSnapshot() only fires when the query RESULTS
   * change, so on a perfectly healthy but idle connection (nobody's
   * written anything in a while — e.g. reading a suggestion before
   * tapping "Take court") it never fires again, and "time since last
   * update" falsely looks identical to "connection died." Passing
   * { includeMetadataChanges: true } makes the listener also fire
   * when the SDK's own view of connectivity changes, giving a real
   * online/offline signal instead of a proxy that's wrong the instant
   * nothing happens to change.
   */
  online: boolean;
  /**
   * Set when the LIVE query returns more than one session (dated
   * today or later). startSession() now refuses to create a second
   * LIVE session in the first place — but this is the backstop for
   * every OTHER way it could still happen (a direct Firestore edit, a
   * bug, two admins racing before that check existed). Hit this for
   * real three times in one afternoon; the failure mode is silent and
   * arbitrary — whichever phone's listener resolves first shows a
   * DIFFERENT session, with no indication anything is wrong. So:
   * `session` becomes null while this is set, rather than picking one.
   */
  liveConflict: SessionDoc[] | null;
} {
  const [live, setLive] = useState<SessionDoc | null | undefined>(undefined);
  const [nearestDraft, setNearestDraft] = useState<SessionDoc | null | undefined>(undefined);
  const [liveFromCache, setLiveFromCache] = useState(false);
  const [draftFromCache, setDraftFromCache] = useState(false);
  const [liveConflict, setLiveConflict] = useState<SessionDoc[] | null>(null);

  useEffect(() => {
    const liveQuery = query(collection(db, 'sessions'), where('status', '==', 'LIVE'));
    const unsubLive = onSnapshot(liveQuery, { includeMetadataChanges: true }, snap => {
      const today = todayDateString();
      const current = snap.docs
        .map(d => d.data() as SessionDoc)
        .filter(s => s.date >= today);   // stale LIVE (date < today) → never resurrects
      if (current.length > 1) {
        setLiveConflict(current);
        setLive(null);                  // never silently pick one
      } else {
        setLiveConflict(null);
        setLive(current.length > 0 ? current[0] : null);
      }
      setLiveFromCache(snap.metadata.fromCache);
    });

    const today = todayDateString();
    const draftQuery = query(collection(db, 'sessions'), where('status', '==', 'DRAFT'));
    const unsubDraft = onSnapshot(draftQuery, { includeMetadataChanges: true }, snap => {
      const upcoming = snap.docs
        .map(d => d.data() as SessionDoc)
        .filter(s => s.date >= today)
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
      setNearestDraft(upcoming.length > 0 ? upcoming[0] : null);
      setDraftFromCache(snap.metadata.fromCache);
    });

    return () => {
      unsubLive();
      unsubDraft();
    };
  }, []);

  const loading = live === undefined || nearestDraft === undefined;
  const session = live ?? nearestDraft ?? null;
  const online = !liveFromCache && !draftFromCache;

  return { session, loading, online, liveConflict };
}
