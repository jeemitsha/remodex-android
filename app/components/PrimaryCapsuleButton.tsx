// Mirrors iOS PrimaryCapsuleButton.swift — full-width white capsule, black text, 56pt tall.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/lib/icons';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type Props = {
  title: string;
  systemImage?: string;
  onPress: () => void;
  disabled?: boolean;
};

export function PrimaryCapsuleButton({ title, systemImage, onPress, disabled }: Props) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.root,
        pressed && !disabled && { opacity: 0.85 },
        disabled && { opacity: 0.45 },
      ]}>
      <View style={styles.row}>
        {systemImage && (
          <Icon name={systemImage} size={15} color="#000" />
        )}
        <Text style={styles.label}>{title}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    height: 56,
    backgroundColor: colors.fg,
    borderRadius: radius.capsule,
    alignItems: 'center',
    justifyContent: 'center',
    width: '100%',
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm + 2 },
  label: { color: '#000', fontSize: fontSize.body, fontWeight: weight.semibold },
});
