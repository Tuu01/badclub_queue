'use client';

// Đọc trực tiếp qua client SDK (onSnapshot) — never through Vercel.
// sessions/{sid} cho phép đọc mở (firestore.rules).

import { useEffect, useState } from 'react';
import { doc, onSnapshot } from 'firebase/firestore';
import { db } from './firebase-client';
import type { SessionDoc } from './firestore';

export function useSession(sessionId: string): {
  session: SessionDoc | null;
  loading: boolean;
  lastUpdateAt: number | null;
} {
  const [session, setSession] = useState<SessionDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdateAt, setLastUpdateAt] = useState<number | null>(null);

  useEffect(() => {
    const unsub = onSnapshot(doc(db, 'sessions', sessionId), snap => {
      setSession(snap.exists() ? (snap.data() as SessionDoc) : null);
      setLoading(false);
      setLastUpdateAt(Date.now());
    });
    return unsub;
  }, [sessionId]);

  return { session, loading, lastUpdateAt };
}
