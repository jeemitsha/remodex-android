// MUST be the very first import — polyfills global crypto.getRandomValues()
// using expo-crypto so @noble/curves can generate Ed25519/X25519 keys.
import '@/lib/polyfills/crypto';

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import 'react-native-reanimated';

export default function RootLayout() {
  return (
    <>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: '#000' },
          animation: 'fade',
        }}
      />
      <StatusBar style="light" />
    </>
  );
}
