// Mirrors OnboardingStepPage.swift — icon-with-glow, "STEP n" label,
// title, description, command card.

import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Icon } from '@/lib/icons';
import { OnboardingCommandCard } from '@/components/OnboardingCommandCard';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type Props = {
  stepNumber: number;
  icon: string;
  title: string;
  description: string;
  command?: string;
  commandCaption?: string;
};

export function OnboardingStepPage({
  stepNumber,
  icon,
  title,
  description,
  command,
  commandCaption,
}: Props) {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.root, { width }]}>
      {/* Soft radial glow simulation: a centered circle with low-opacity .plan */}
      <View style={styles.glow} pointerEvents="none" />

      <View style={styles.center}>
        <View style={styles.iconWrap}>
          <View style={styles.iconGlow} />
          <View style={styles.iconTile}>
            <Icon name={icon} size={32} color={colors.fg} />
          </View>
        </View>

        <View style={styles.text}>
          <Text style={styles.stepLabel}>STEP {stepNumber}</Text>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.description}>{description}</Text>
        </View>

        {command && (
          <View style={styles.commandWrap}>
            <OnboardingCommandCard command={command} />
            {commandCaption ? <Text style={styles.caption}>{commandCaption}</Text> : null}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: colors.bg,
    paddingHorizontal: spacing.xxxl,
  },
  glow: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    width: 680,
    height: 680,
    marginLeft: -340,
    marginTop: -400, // -60 offset on top of -340 to mimic Swift offset(y: -60)
    borderRadius: 340,
    backgroundColor: colors.planFaint,
    opacity: 0.45,
  },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 36 },
  iconWrap: { width: 140, height: 140, alignItems: 'center', justifyContent: 'center' },
  iconGlow: {
    position: 'absolute',
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: colors.planSoft,
    opacity: 0.6,
  },
  iconTile: {
    width: 80,
    height: 80,
    borderRadius: radius.iconTile,
    backgroundColor: colors.fg6,
    borderWidth: 1,
    borderColor: colors.planBorderTop,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { alignItems: 'center', gap: spacing.md },
  stepLabel: {
    color: 'rgba(0,150,255,0.7)',
    fontSize: fontSize.caption2,
    fontWeight: weight.bold,
    letterSpacing: 1.5,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.pageTitle,
    fontWeight: weight.bold,
    textAlign: 'center',
  },
  description: {
    color: colors.fg45,
    fontSize: fontSize.subheadline,
    fontWeight: weight.regular,
    textAlign: 'center',
    lineHeight: fontSize.subheadline + 6,
  },
  commandWrap: { alignSelf: 'stretch', gap: spacing.sm + 2 },
  caption: { color: colors.fg45, fontSize: fontSize.caption, lineHeight: 16 },
});
