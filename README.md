# Remodex Android (third-party client)

Android (Expo + React Native) client for the [Remodex](https://github.com/Emanuele-web04/remodex) bridge protocol. Apache-2.0. Built clean-room from upstream's open-source Swift + JS sources.

> **What this is**: control the Codex CLI on your Mac from your Android phone, end-to-end encrypted. Same protocol, same relay, same bridge as the official iOS app — just a different client.
>
> **What this is not**: a fork of upstream. The upstream repo is iOS + bridge + relay. This repo is just the Android client; it talks to the upstream-published bridge over the upstream-published relay protocol.

## What works today

| | Status |
|---|---|
| 5-page swipeable onboarding (faithful to OnboardingView.swift) | ✅ |
| QR scan + v2 pairing payload parse | ✅ |
| Full E2EE handshake (Ed25519 + X25519 + HKDF-SHA256 + AES-256-GCM) | ✅ |
| Persistent phone identity (Android Keystore via expo-secure-store) | ✅ |
| Trusted reconnect (`trusted_reconnect` mode) | ✅ |
| Relay's `/v1/trusted/session/resolve` HTTP endpoint — auto-rediscover sessionId across bridge restarts | ✅ |
| `initialize` + `thread/list` — see live Codex threads on phone | ✅ |
| Tap thread → `thread/turns/list` — chat-style timeline | ✅ |
| Compose + send prompt (`turn/start`) with streaming assistant text | ✅ |
| Approve/reject tool-call requests (`*/requestApproval`) | ✅ |
| iOS-fidelity sidebar — project sections, status dots, relative time | ✅ |
| Image attachments | ❌ planned |
| Voice input | ❌ planned |
| Git actions from phone | ❌ planned |
| Push notifications when away from app | ❌ planned (needs FCM relay extension) |
| Plan mode / collaboration mode toggle | ❌ planned |
| EAS dev build → real APK | ❌ planned (currently Expo Go only) |

## Quick start (local development)

You need:
- A Mac running [`remodex up`](https://github.com/Emanuele-web04/remodex) (the bridge)
- An Android device on the same Wi-Fi as the Mac, with [Expo Go](https://play.google.com/store/apps/details?id=host.exp.exponent) installed
- Node 20+ on the Mac

Three terminals on the Mac:

```bash
# 1. Local patched relay (needed because Expo Go's WebSocket strips
#    custom request headers — see relay-local/relay.js for the
#    one-line ?role= query-string fallback. Upstream PR is open at
#    https://github.com/Emanuele-web04/remodex/pull/107.)
cd relay-local
BIND_HOST=0.0.0.0 PORT=9000 npm install --silent && npm start

# 2. The Remodex bridge, pointed at the local relay
REMODEX_RELAY=ws://<your-mac-lan-ip>:9000/relay remodex up

# 3. The Expo dev server
cd app
npm install --silent
npx expo start --lan
```

Then on the phone:

1. Open Expo Go → tap **Enter URL manually** → type `exp://<your-mac-lan-ip>:8081`
2. Step through onboarding to the last page → **Scan with QR Code**
3. Scan the QR printed by `remodex up`
4. After pairing, tap any thread to see its turns; type in the composer to send a new prompt

## Architecture

```
[Android (Expo Go)]   ⇄   [Relay :9000]   ⇄   [remodex up]   ⇄   [codex app-server]
  Ed25519 identity         passive               WS client           stdio JSON-RPC
  X25519 ECDH              matchmaker            E2EE proxy          (Codex's own
  AES-256-GCM envelope     (sees only            (sees Codex          control plane)
  Persisted in             encrypted             stdio in plain)
  Keystore                 envelopes)
```

All crypto is end-to-end between the phone and the Mac. The relay only matchmakes by sessionId and pipes encrypted frames; it never sees plaintext.

## Code layout

```
app/
├── app/                 expo-router routes (onboarding, scan, pair+sessions+turns)
├── components/          OnboardingWelcomePage, OnboardingStepPage, etc.
├── lib/
│   ├── protocol/        crypto, secureTransport, relayClient, identity, qr,
│   │                    trustedSessionResolve
│   ├── state/           pendingPairing, savedPairing
│   ├── theme/           tokens (colors, font sizes, spacing — mirrors AppFont.swift)
│   ├── polyfills/       expo-crypto → globalThis.crypto.getRandomValues
│   ├── icons.tsx        SF Symbol → MaterialCommunityIcons mapping
│   └── sidebar.ts       project grouping + relative-time formatting
├── assets/              hero / app logo PNGs (copied from upstream Assets.xcassets)
└── ...
relay-local/             patched copy of upstream relay/ with ?role= fallback
Docs/PROTOCOL.md         reverse-engineered wire-format spec
AGENTS.md                workspace conventions
```

## Crypto choices

- **`@noble/curves`, `@noble/hashes`, `@noble/ciphers`** — pure-JS, audited, Expo Go-compatible
- **No `react-native-quick-crypto`** — would force an EAS dev build for development; pure JS is fast enough for the handful of envelopes we encrypt per second
- **Polyfill via `expo-crypto`** for `globalThis.crypto.getRandomValues` — the standard React Native polyfill (`react-native-get-random-values`) requires a custom dev build

If/when we move off Expo Go to a real APK build, swapping noble for `react-native-quick-crypto` is a one-day refactor — the API surface is similar.

## Why a separate repo, not a PR upstream?

The upstream repo is structured for iOS Swift + Node bridge + Node relay. Adding a 1000-file Expo project under it would be unusual mixing, and the upstream README explicitly says "not actively accepting contributions yet." This is the standard third-party-client pattern — see Twitter / Mastodon / Matrix client ecosystems.

That said, **the small relay patch this client depends on is genuinely upstreamable** and is open as [PR #107](https://github.com/Emanuele-web04/remodex/pull/107). 12 lines, additive, all 32 existing tests pass, no behavior change for the iOS path.

## License

Apache-2.0, matching upstream.

## Acknowledgements

[Emanuele-web04/remodex](https://github.com/Emanuele-web04/remodex) — the original Remodex project, including the bridge, relay, and iOS app, all under Apache-2.0. This client is built clean-room against the published wire protocol; no Swift code is reused.
