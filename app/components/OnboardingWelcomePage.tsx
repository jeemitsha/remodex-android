// Mirrors OnboardingWelcomePage.swift — full-bleed hero, gradient fade,
// app logo + name + tagline + lock badge anchored to the bottom.

import { LinearGradient } from 'expo-linear-gradient';
import { Image, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { Icon } from '@/lib/icons';
import { colors, fontSize, radius, spacing, weight } from '@/lib/theme/tokens';

export function OnboardingWelcomePage() {
  const { width, height } = useWindowDimensions();
  return (
    <View style={[styles.root, { width, height }]}>
      <Image
        source={require('@/assets/images/onboarding-hero.png')}
        style={[styles.hero, { width }]}
        resizeMode="contain"
      />
      <LinearGradient
        colors={['transparent', 'rgba(0,0,0,0.5)', '#000']}
        locations={[0.45, 0.6, 0.72]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View style={styles.content}>
        <Image
          source={require('@/assets/images/app-logo.png')}
          style={styles.logo}
        />
        <View style={{ alignItems: 'center', gap: spacing.sm }}>
          <Text style={styles.title}>Remodex</Text>
          <Text style={styles.tagline}>Control Codex from your iPhone.</Text>
        </View>
        <View style={styles.badge}>
          <Icon name="lock.shield.fill" size={11} color={colors.fg50} />
          <Text style={styles.badgeText}>End-to-end encrypted</Text>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.bg },
  hero: { position: 'absolute', top: 0, left: 0, height: '100%' },
  content: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 28,
    paddingHorizontal: spacing.xxxl,
    alignItems: 'center',
    gap: spacing.xxl,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.fg25,
  },
  title: {
    color: colors.fg,
    fontSize: fontSize.pageHero,
    fontWeight: weight.bold,
  },
  tagline: {
    color: colors.fg50,
    fontSize: fontSize.subheadline,
    fontWeight: weight.regular,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  badgeText: {
    color: colors.fg50,
    fontSize: fontSize.caption,
    fontWeight: weight.medium,
  },
});
