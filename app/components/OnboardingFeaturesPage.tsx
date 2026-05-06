// Mirrors OnboardingFeaturesPage.swift — 5 colored-icon rows with title/subtitle.

import { StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Icon } from '@/lib/icons';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

type Feature = {
  icon: string;
  color: string;
  bg: string;
  title: string;
  subtitle: string;
};

const FEATURES: Feature[] = [
  {
    icon: 'hare.fill',
    color: colors.featureYellow,
    bg: colors.featureYellowBg,
    title: 'Fast mode',
    subtitle: 'Lower-latency turns for quick interactions',
  },
  {
    icon: 'arrow.triangle.branch',
    color: colors.featureGreen,
    bg: colors.featureGreenBg,
    title: 'Git from your phone',
    subtitle: 'Commit, push, pull, and switch branches',
  },
  {
    icon: 'lock.shield.fill',
    color: colors.featureCyan,
    bg: colors.featureCyanBg,
    title: 'End-to-end encrypted',
    subtitle: 'The relay never sees your prompts or code',
  },
  {
    icon: 'waveform',
    color: colors.featurePurple,
    bg: colors.featurePurpleBg,
    title: 'Voice mode',
    subtitle: 'Talk to Codex with speech-to-text',
  },
  {
    icon: 'point.3.connected.trianglepath.dotted',
    color: colors.featureOrange,
    bg: colors.featureOrangeBg,
    title: 'Subagents, skills and /commands',
    subtitle: 'Spawn and monitor parallel agents from your phone',
  },
];

export function OnboardingFeaturesPage() {
  const { width } = useWindowDimensions();
  return (
    <View style={[styles.root, { width }]}>
      <View style={styles.center}>
        <View style={styles.header}>
          <Text style={styles.title}>What you get</Text>
          <Text style={styles.tagline}>
            Everything runs on your computer.{'\n'}Your phone is the remote.
          </Text>
        </View>

        <View style={styles.list}>
          {FEATURES.map((f) => (
            <View key={f.title} style={styles.row}>
              <View style={[styles.iconTile, { backgroundColor: f.bg }]}>
                <Icon name={f.icon} size={14} color={f.color} />
              </View>
              <View style={styles.text}>
                <Text style={styles.rowTitle}>{f.title}</Text>
                <Text style={styles.rowSubtitle} numberOfLines={2}>
                  {f.subtitle}
                </Text>
              </View>
            </View>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg, paddingHorizontal: spacing.xxxl },
  center: { flex: 1, justifyContent: 'center', gap: 40 },
  header: { alignItems: 'center', gap: spacing.md - 2 },
  title: {
    color: colors.fg,
    fontSize: fontSize.pageTitle,
    fontWeight: weight.bold,
  },
  tagline: {
    color: colors.fg45,
    fontSize: fontSize.subheadline,
    fontWeight: weight.regular,
    lineHeight: fontSize.subheadline + 6,
    textAlign: 'center',
  },
  list: { gap: spacing.lg, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  iconTile: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: { flex: 1, gap: 2 },
  rowTitle: {
    color: colors.fg,
    fontSize: fontSize.subheadline,
    fontWeight: weight.semibold,
  },
  rowSubtitle: {
    color: colors.fg40,
    fontSize: fontSize.caption,
    fontWeight: weight.regular,
  },
});
