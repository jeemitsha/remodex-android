// Maps the SF Symbol names used in the iOS Remodex app to closest-equivalent
// MaterialCommunityIcons (cross-platform). On both iOS and Android we render
// MCI for visual consistency in our app — pure SF Symbols would only work on
// iOS, and we want one design across platforms.

import { MaterialCommunityIcons } from '@expo/vector-icons';
import { ComponentProps } from 'react';

type MciName = ComponentProps<typeof MaterialCommunityIcons>['name'];

const ICON_MAP: Record<string, MciName> = {
  // Onboarding step icons
  terminal: 'console',
  link: 'link-variant',
  'qrcode.viewfinder': 'qrcode-scan',
  // Buttons
  qrcode: 'qrcode',
  keyboard: 'keyboard-outline',
  // Features page
  'hare.fill': 'rabbit',
  'arrow.triangle.branch': 'source-branch',
  'lock.shield.fill': 'shield-lock',
  waveform: 'waveform',
  'point.3.connected.trianglepath.dotted': 'graph-outline',
  // Composer (iOS Codex parity)
  plus: 'plus',
  'arrow.up': 'arrow-up',
  'arrow.up.circle.fill': 'arrow-up-circle',
  mic: 'microphone',
  'mic.fill': 'microphone',
  'stop.fill': 'stop',
  photo: 'image-outline',
  camera: 'camera-outline',
  paperclip: 'paperclip',
  checklist: 'format-list-checks',
  'bolt.fill': 'lightning-bolt',
  'chevron.down': 'chevron-down',
  // Misc
  checkmark: 'check',
  'chevron.left': 'chevron-left',
  copy: 'content-copy',
  xmark: 'close',
};

type Props = {
  name: keyof typeof ICON_MAP | string;
  size?: number;
  color?: string;
};

export function Icon({ name, size = 16, color = '#ffffff' }: Props) {
  const mciName = (ICON_MAP[name] ?? 'help-circle-outline') as MciName;
  return <MaterialCommunityIcons name={mciName} size={size} color={color} />;
}
