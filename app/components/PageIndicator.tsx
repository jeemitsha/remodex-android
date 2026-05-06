// Mirrors the animated pill dots from OnboardingView.swift.
// Active dot: 24×8 white capsule. Inactive: 8×8, 18% white.

import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { colors, radius, spacing } from '@/lib/theme/tokens';

type Props = { count: number; current: number };

const ACTIVE_W = 24;
const INACTIVE_W = 8;
const SPRING = { damping: 15, stiffness: 220, mass: 0.7 };

export function PageIndicator({ count, current }: Props) {
  return (
    <View style={styles.row}>
      {Array.from({ length: count }, (_, i) => (
        <Dot key={i} active={i === current} />
      ))}
    </View>
  );
}

function Dot({ active }: { active: boolean }) {
  const width = useSharedValue(active ? ACTIVE_W : INACTIVE_W);

  useEffect(() => {
    width.value = withSpring(active ? ACTIVE_W : INACTIVE_W, SPRING);
  }, [active, width]);

  const style = useAnimatedStyle(() => ({ width: width.value }));

  return (
    <Animated.View
      style={[
        styles.dot,
        { backgroundColor: active ? colors.fg : colors.fg18 },
        style,
      ]}
    />
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  dot: { height: 8, borderRadius: radius.capsule },
});
