// Mirrors OnboardingView.swift — 5-page swipeable onboarding with fixed bottom bar.
// Pages: Welcome → Features → Step 1 (Codex CLI) → Step 2 (Bridge) → Step 3 (remodex up).
// Final page swaps the primary button for "Scan with QR Code" + "Pair with Code".
// On mount, if a saved pairing exists, we redirect to /pair to auto-reconnect
// instead of forcing the user through onboarding again.

import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  NativeScrollEvent,
  NativeSyntheticEvent,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';

import { OnboardingFeaturesPage } from '@/components/OnboardingFeaturesPage';
import { OnboardingStepPage } from '@/components/OnboardingStepPage';
import { OnboardingWelcomePage } from '@/components/OnboardingWelcomePage';
import { PageIndicator } from '@/components/PageIndicator';
import { PrimaryCapsuleButton } from '@/components/PrimaryCapsuleButton';
import { SecondaryCapsuleButton } from '@/components/SecondaryCapsuleButton';
import { loadSavedPairing } from '@/lib/state/savedPairing';
import { colors, spacing } from '@/lib/theme/tokens';

const PAGE_COUNT = 5;
const CODEX_INSTALL_STEP_INDEX = 2;
const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex@latest';

type PageItem = { key: string };

const PAGES: PageItem[] = Array.from({ length: PAGE_COUNT }, (_, i) => ({ key: `p${i}` }));

export default function OnboardingScreen() {
  const router = useRouter();
  const { width } = useWindowDimensions();
  const listRef = useRef<FlatList<PageItem>>(null);
  const [page, setPage] = useState(0);
  const [bootCheck, setBootCheck] = useState<'pending' | 'no-saved' | 'redirecting'>('pending');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const saved = await loadSavedPairing();
      if (cancelled) return;
      if (saved) {
        setBootCheck('redirecting');
        router.replace('/pair');
      } else {
        setBootCheck('no-saved');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (bootCheck !== 'no-saved') {
    return (
      <View style={[styles.root, { alignItems: 'center', justifyContent: 'center' }]}>
        <ActivityIndicator color={colors.fg} />
      </View>
    );
  }

  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const x = e.nativeEvent.contentOffset.x;
      const next = Math.round(x / width);
      if (next !== page) setPage(next);
    },
    [page, width],
  );

  const goTo = useCallback(
    (i: number) => {
      listRef.current?.scrollToIndex({ index: i, animated: true });
      setPage(i);
    },
    [],
  );

  const handleContinue = useCallback(() => {
    if (page === CODEX_INSTALL_STEP_INDEX) {
      Alert.alert(
        'Install Codex CLI First',
        `Copy and paste "${CODEX_INSTALL_COMMAND}" on your computer before moving on. Remodex will not work until Codex CLI is installed and available in your PATH.`,
        [
          { text: 'Stay Here', style: 'cancel' },
          { text: 'Continue Anyway', onPress: () => goTo(page + 1) },
        ],
      );
      return;
    }

    if (page < PAGE_COUNT - 1) {
      goTo(page + 1);
    } else {
      router.push('/scan');
    }
  }, [goTo, page, router]);

  const buttonTitle =
    page === 0 ? 'Get Started' : page === 1 ? 'Set Up' : 'Continue';

  const onFinalScan = useCallback(() => router.push('/scan'), [router]);
  const onFinalCode = useCallback(() => {
    Alert.alert('Pair with Code', 'Manual pairing-code entry is not implemented in this build yet.');
  }, []);

  return (
    <View style={styles.root}>
      <FlatList
        ref={listRef}
        data={PAGES}
        keyExtractor={(it) => it.key}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        bounces={false}
        onScroll={onScroll}
        scrollEventThrottle={16}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ index }) => {
          switch (index) {
            case 0:
              return <OnboardingWelcomePage />;
            case 1:
              return <OnboardingFeaturesPage />;
            case 2:
              return (
                <OnboardingStepPage
                  stepNumber={1}
                  icon="terminal"
                  title="Install Codex CLI"
                  description="The AI coding agent that lives in your terminal. Remodex connects to it from your iPhone."
                  command={CODEX_INSTALL_COMMAND}
                />
              );
            case 3:
              return (
                <OnboardingStepPage
                  stepNumber={2}
                  icon="link"
                  title="Install the Bridge"
                  description="A lightweight relay that securely connects your Mac to your iPhone."
                  command="npm install -g remodex@latest"
                  commandCaption="Remodex can keep your Mac awake with macOS caffeinate while the bridge is running, but it starts disabled by default. You can enable it later in Settings if you want."
                />
              );
            case 4:
              return (
                <OnboardingStepPage
                  stepNumber={3}
                  icon="qrcode.viewfinder"
                  title="Start Pairing"
                  description="Run this on your computer. A QR code will appear in your terminal — scan it next."
                  command="remodex up"
                />
              );
            default:
              return null;
          }
        }}
      />

      {/* Bottom bar with gradient fade above */}
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.6)', '#000']}
        pointerEvents="none"
        style={styles.bottomFade}
      />
      <View style={styles.bottomBar}>
        <PageIndicator count={PAGE_COUNT} current={page} />

        {page === PAGE_COUNT - 1 ? (
          <View style={{ width: '100%', gap: 10 }}>
            <PrimaryCapsuleButton
              title="Scan with QR Code"
              systemImage="qrcode"
              onPress={onFinalScan}
            />
            <SecondaryCapsuleButton
              title="Pair with Code"
              systemImage="keyboard"
              onPress={onFinalCode}
            />
          </View>
        ) : (
          <PrimaryCapsuleButton title={buttonTitle} onPress={handleContinue} />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  bottomFade: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 154,
    height: 50,
  },
  bottomBar: {
    paddingHorizontal: spacing.xxl,
    paddingBottom: spacing.md,
    paddingTop: spacing.lg,
    gap: spacing.xl,
    alignItems: 'center',
    backgroundColor: colors.bg,
  },
});
