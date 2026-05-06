// Persists the pairing context from a successful handshake so we can skip
// QR scanning on subsequent launches (Level 1) or refresh the sessionId
// against the relay's trusted-session-resolve endpoint (Level 2 — TODO).
//
// What we save:
//   - relay base URL (so we can resolve a fresh sessionId later)
//   - sessionId from the most recent successful pair
//   - macDeviceId + macIdentityPublicKey (Mac's long-term identity)
//   - savedAt (informational only)
//
// What we DON'T save:
//   - The QR's expiresAt — irrelevant after the bootstrap pair
//   - AES session keys — derived per-handshake, never persisted

import * as SecureStore from 'expo-secure-store';

const KEY = 'remodex.savedPairing.v1';

export type SavedPairing = {
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  savedAt: number;
};

export async function saveSavedPairing(pairing: Omit<SavedPairing, 'savedAt'>): Promise<void> {
  const payload: SavedPairing = { ...pairing, savedAt: Date.now() };
  await SecureStore.setItemAsync(KEY, JSON.stringify(payload));
}

export async function loadSavedPairing(): Promise<SavedPairing | null> {
  const raw = await SecureStore.getItemAsync(KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SavedPairing;
    if (
      typeof parsed.relay !== 'string'
      || typeof parsed.sessionId !== 'string'
      || typeof parsed.macDeviceId !== 'string'
      || typeof parsed.macIdentityPublicKey !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function clearSavedPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
