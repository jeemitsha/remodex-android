# AGENTS.md — Remodex Android Port

Working directory for an Android (Expo / React Native) client for the Remodex bridge protocol. Upstream Remodex repo lives at `~/Codebase/personal/remodex/` and is iOS-only.

## Identity & git rules (HARD)

All commits, pushes, PRs, and any GitHub operation in this workspace MUST use:

- **Git author**: `jeemitsha <jeemitsha@gmail.com>`
- **GitHub account**: `jeemitsha`

The user's global git config defaults to a different work identity (`opencode@nidana.io`). Do **not** rely on it. Do **not** modify the global config. Scope identity to this project only:

```bash
# Once, after `git init` or `git clone` inside this dir:
git config user.email jeemitsha@gmail.com
git config user.name jeemitsha

# Before that, or for one-off commits:
git -c user.email=jeemitsha@gmail.com -c user.name=jeemitsha commit -m "..."
```

Before any `git push` or `gh pr create`, verify:

```bash
git config user.email           # must print jeemitsha@gmail.com
gh auth status                  # must show jeemitsha as the active account
```

If `gh auth status` shows a different account, switch with `gh auth switch -u jeemitsha` (or `gh auth login` for first-time setup).

## What this project is

An Android client for the Remodex bridge (`remodex` npm package on the user's Mac), built in Expo + React Native + TypeScript so the same codebase also produces an alternative iOS client. The upstream iOS app is closed-feature ("not accepting contributions yet"), so we build clean-room against the public Apache-2.0 protocol.

## What lives where

- `~/Codebase/personal/remodex/` — upstream Remodex source (clone, do not modify, used as protocol reference)
- `~/Codebase/personal/remodex-android/` — this project (Expo app + protocol spec)
- `~/Codebase/personal/remodex-android/Docs/PROTOCOL.md` — wire-format spec we extract from the upstream Swift + JS sources

## Stack decision

- **Expo (managed) + TypeScript + Jetpack-Compose-equivalent React Native UI**
- Crypto: `react-native-quick-crypto` (Node-compatible API; matches upstream's use of Node's built-in `crypto`)
- Camera/QR: `expo-camera` + `expo-barcode-scanner`
- Secret storage: `expo-secure-store` (wraps Android Keystore + iOS Keychain)
- Notifications: `expo-notifications` (FCM under the hood) — deferred to v2
- Build: EAS Build dev profile (Expo Go cannot load custom native crypto modules)

## Don't do these

- Do **not** modify files inside `~/Codebase/personal/remodex/` — that's an unmodified clone of upstream for reference reads. If we ever need to fork the bridge, it'll be a separate `phodex-bridge-fork/` directory.
- Do **not** commit the upstream's pairing JSON, sessionIds, or any device keys to git — they are bearer-like secrets per upstream's CLAUDE.md guidance.
- Do **not** add hardcoded relay URLs or production domains. Local-first only, matching upstream's posture.
