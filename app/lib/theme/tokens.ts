// Design tokens mirrored from the iOS Remodex app.
// Sources: AppFont.swift, plan.colorset (dark mode), Onboarding/* views.

export const colors = {
  // Backgrounds
  bg: '#000000',
  bgPanel: 'rgba(255,255,255,0.05)',
  bgPanelStrong: 'rgba(255,255,255,0.06)',

  // Plan accent (iOS .plan dark mode = srgb 0,0.59,1.0)
  plan: '#0096FF',
  planSoft: 'rgba(0,150,255,0.18)',
  planFaint: 'rgba(0,150,255,0.06)',
  planBorderTop: 'rgba(0,150,255,0.35)',
  planBorderBottom: 'rgba(0,150,255,0.08)',

  // Foreground tints (white at iOS-canonical opacities)
  fg: '#ffffff',
  fg82: 'rgba(255,255,255,0.82)',
  fg70: 'rgba(255,255,255,0.70)',
  fg50: 'rgba(255,255,255,0.50)',
  fg45: 'rgba(255,255,255,0.45)',
  fg40: 'rgba(255,255,255,0.40)',
  fg35: 'rgba(255,255,255,0.35)',
  fg30: 'rgba(255,255,255,0.30)',
  fg25: 'rgba(255,255,255,0.25)',
  fg18: 'rgba(255,255,255,0.18)',
  fg12: 'rgba(255,255,255,0.12)',
  fg10: 'rgba(255,255,255,0.10)',
  fg7: 'rgba(255,255,255,0.07)',
  fg6: 'rgba(255,255,255,0.06)',
  fg5: 'rgba(255,255,255,0.05)',
  fg4: 'rgba(255,255,255,0.04)',

  // Feature row icon tints (from OnboardingFeaturesPage colors)
  featureYellow: '#FFD60A',
  featureGreen: '#30D158',
  featureCyan: '#64D2FF',
  featurePurple: '#BF5AF2',
  featureOrange: '#FF9F0A',
  // Per-feature 12% tint backgrounds:
  featureYellowBg: 'rgba(255,214,10,0.12)',
  featureGreenBg: 'rgba(48,209,88,0.12)',
  featureCyanBg: 'rgba(100,210,255,0.12)',
  featurePurpleBg: 'rgba(191,90,242,0.12)',
  featureOrangeBg: 'rgba(255,159,10,0.12)',
} as const;

// AppFont sizes verbatim from AppFont.swift
export const fontSize = {
  caption2: 10,
  caption: 11,
  footnote: 12,
  subheadline: 14,
  callout: 14.5,
  body: 15,
  headline: 15.5,
  title3: 18,
  title2: 20,
  pageTitle: 28,
  pageHero: 32,
} as const;

// Font weights matching SwiftUI .regular / .medium / .semibold / .bold
export const weight = {
  regular: '400',
  medium: '500',
  semibold: '600',
  bold: '700',
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 28,
  page: 28,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  card: 18,
  iconTile: 22,
  capsule: 999,
} as const;
