'use client';

// Reads directly via the client SDK (onSnapshot) — never through Vercel.
// clubs/{cid}/players allows open reads (firestore.rules).

import { useEffect, useState } from 'react';
import { collection, onSnapshot } from 'firebase/firestore';
import { db } from './firebase-client';
import { CLUB_ID } from './constants';
import type { PublicPlayerDoc } from './firestore';

export function usePlayers(): { players: PublicPlayerDoc[]; loading: boolean } {
  const [players, setPlayers] = useState<PublicPlayerDoc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onSnapshot(collection(db, `clubs/${CLUB_ID}/players`), snap => {
      setPlayers(snap.docs.map(d => d.data() as PublicPlayerDoc));
      setLoading(false);
    });
    return unsub;
  }, []);

  return { players, loading };
}
