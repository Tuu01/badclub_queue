// ============================================================
// firebase-client.ts — Client SDK, runs in the browser.
// Read-only (onSnapshot). Writes always go through a Route Handler + Admin SDK.
// ============================================================

import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
};

export const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);

// LOCAL DEMO/DEV ONLY — point the browser at the Firestore emulator when
// NEXT_PUBLIC_FIRESTORE_EMULATOR is set (e.g. "localhost:8080"). Lets us seed
// a rich, fake club locally without ever touching the real club's data. The
// var is never set in production, so this is inert there. The Admin SDK picks
// the emulator up on its own via FIRESTORE_EMULATOR_HOST — no server change.
const EMU = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR;
if (EMU && typeof window !== 'undefined') {
  const [host, port] = EMU.split(':');
  connectFirestoreEmulator(db, host || 'localhost', Number(port) || 8080);
}
