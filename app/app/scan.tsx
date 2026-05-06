// QR scanner screen. Mirrors QRScannerView.swift's structure:
// - back button in top-left safe area
// - permission gate
// - centered camera with reticle overlay
// - error alert on bad QR
// On success, parses the v=2 pairing payload and shows it (next step is the
// secure handshake, not implemented yet).

import { CameraView, useCameraPermissions } from 'expo-camera';
import { Stack, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Icon } from '@/lib/icons';
import { parsePairingQR } from '@/lib/protocol/qr';
import { pendingPairing } from '@/lib/state/pendingPairing';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type ScanState =
  | { kind: 'permission-loading' }
  | { kind: 'permission-denied' }
  | { kind: 'scanning' };

export default function ScanScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const [state, setState] = useState<ScanState>({ kind: 'permission-loading' });
  const scanLock = useRef(false);

  useEffect(() => {
    if (!permission) return;
    if (!permission.granted) {
      if (permission.canAskAgain) {
        requestPermission();
      } else {
        setState({ kind: 'permission-denied' });
      }
      return;
    }
    setState((prev) => (prev.kind === 'permission-loading' ? { kind: 'scanning' } : prev));
  }, [permission, requestPermission]);

  const handleScan = useCallback(
    (raw: string) => {
      if (scanLock.current) return;
      scanLock.current = true;

      const result = parsePairingQR(raw);
      if (!result.ok) {
        Alert.alert('Pairing Error', result.error, [
          { text: 'OK', onPress: () => (scanLock.current = false) },
        ]);
        return;
      }
      if (result.isExpired) {
        Alert.alert(
          'QR Expired',
          'This pairing QR has expired. Re-run `remodex up` on your Mac to generate a new one.',
          [{ text: 'OK', onPress: () => (scanLock.current = false) }],
        );
        return;
      }

      pendingPairing.set(result.payload);
      router.replace('/pair');
    },
    [router],
  );

  return (
    <View style={styles.root}>
      <Stack.Screen options={{ headerShown: false }} />

      {state.kind === 'scanning' && (
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => handleScan(data)}
        />
      )}

      {state.kind === 'scanning' && (
        <View pointerEvents="none" style={styles.overlay}>
          <View style={styles.reticle} />
          <Text style={styles.overlayText}>
            Point at the QR from <Text style={{ fontWeight: weight.semibold }}>remodex up</Text> on your Mac
          </Text>
        </View>
      )}

      {state.kind === 'permission-loading' && (
        <View style={styles.centered}>
          <Text style={styles.centeredText}>Requesting camera permission…</Text>
        </View>
      )}

      {state.kind === 'permission-denied' && (
        <View style={styles.centered}>
          <Text style={styles.centeredText}>
            Camera permission denied. Enable it in system settings to scan a Remodex pairing QR.
          </Text>
        </View>
      )}

      <SafeAreaView style={styles.topBar} pointerEvents="box-none" edges={['top']}>
        <Pressable
          onPress={() => router.back()}
          hitSlop={12}
          style={styles.backBtn}>
          <Icon name="chevron.left" size={20} color={colors.fg} />
        </Pressable>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  backBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reticle: {
    width: 240,
    height: 240,
    borderColor: 'rgba(255,255,255,0.85)',
    borderWidth: 2,
    borderRadius: radius.card,
  },
  overlayText: {
    color: colors.fg,
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xxxl,
    textAlign: 'center',
    fontSize: fontSize.subheadline,
  },
  centered: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xxl },
  centeredText: {
    color: colors.fg,
    fontSize: fontSize.subheadline,
    textAlign: 'center',
  },
});
