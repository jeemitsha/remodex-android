// Mirrors the inline secondaryCapsuleButton in OnboardingView.swift —
// translucent white fill, 1pt border at 18% white, white label.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/lib/icons';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type Props = {
  title: string;
  systemImage?: string;
  onPress: () => void;
};

export function SecondaryCapsuleButton({ title, systemImage, onPress }: Props) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [styles.root, pressed && { opacity: 0.7 }]}>
      <View style={styles.row}>
        {systemImage && <Icon name={systemImage} size={15} color={colors.fg} />}
        <Text style={styles.label}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    height: 54,
    backgroundColor: colors.fg10,
    borderColor: colors.fg18,
    borderWidth: 1,
    borderRadius: radius.capsule,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  label: { color: colors.fg, fontSize: fontSize.body, fontWeight: weight.semibold },
});
