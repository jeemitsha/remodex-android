// Polyfills globalThis.crypto.getRandomValues using expo-crypto's synchronous
// getRandomBytes. Required by @noble/curves for Ed25519/X25519 key generation.
// We pick expo-crypto over react-native-get-random-values because expo-crypto
// is guaranteed available in Expo Go — no EAS dev build prerequisite.
//
// Import this module *before* any code that touches noble. Easiest place:
// the very first import in app/_layout.tsx.

import { getRandomBytes } from 'expo-crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = function getRandomValues<T extends ArrayBufferView>(arr: T): T {
    const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const random = getRandomBytes(u8.length);
    u8.set(random);
    return arr;
  };
}
