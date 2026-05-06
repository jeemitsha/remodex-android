// Mirrors OnboardingCommandCard.swift — rounded 18pt card with mono `$ command` and a copy button.

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useCallback, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { Icon } from '@/lib/icons';
import { colors, fontSize, radius, spacing } from '@/lib/theme/tokens';

const MONO_FAMILY = Platform.select({
  ios: 'Menlo',
  android: 'monospace',
  default: 'monospace',
});

type Props = { command: string };

export function OnboardingCommandCard({ command }: Props) {
  const [copied, setCopied] = useState(false);

  const onCopy = useCallback(async () => {
    await Clipboard.setStringAsync(command);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }, [command]);

  return (
    <View style={styles.card}>
      <Text style={styles.dollar}>$ </Text>
      <Text style={styles.command} numberOfLines={1} adjustsFontSizeToFit>
        {command}
      </Text>
      <Pressable
        onPress={onCopy}
        hitSlop={8}
        style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.6 }]}>
        <Icon
          name={copied ? 'checkmark' : 'copy'}
          size={15}
          color={copied ? colors.fg : colors.fg35}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 18,
    paddingRight: 10,
    paddingVertical: 6,
    minHeight: 44,
    backgroundColor: colors.fg5,
    borderColor: colors.fg7,
    borderWidth: 1,
    borderRadius: radius.card,
  },
  dollar: {
    color: colors.fg30,
    fontFamily: MONO_FAMILY,
    fontSize: fontSize.caption,
  },
  command: {
    flex: 1,
    color: colors.fg82,
    fontFamily: MONO_FAMILY,
    fontSize: fontSize.caption,
  },
  copyBtn: {
    padding: spacing.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
