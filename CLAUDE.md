# CLAUDE.md — Index

Entry point for Claude / Codex / any agent picking up this project. Lean by design. Read **`Docs/STATE.md`** for everything else.

## What this is

Clean-room **Android (Expo + RN + TypeScript)** client for the [Remodex](https://github.com/Emanuele-web04/remodex) bridge protocol. Apache-2.0. The bridge + iOS app + relay are upstream; this repo is just the Android client + a small upstreamable relay patch.

## Read these first, in order

1. **[`Docs/STATE.md`](Docs/STATE.md)** — current status, what works, what's broken, what's next, where we left off. **Update this file as you go.** This is the source of truth for "what's the project doing right now."
2. **[`Docs/PROTOCOL.md`](Docs/PROTOCOL.md)** — reverse-engineered wire-format spec for the Remodex bridge protocol (handshake, envelope, JSON-RPC methods).
3. **[`AGENTS.md`](AGENTS.md)** — hard rules: git identity (jeemitsha), no modifying the upstream clone, etc.
4. **[`Docs/EAS.md`](Docs/EAS.md)** — EAS dev build runbook (read when Expo Go stops being enough).
5. **[`README.md`](README.md)** — public-facing project description.

## Hard rules (don't violate)

- **Git identity** in this workspace: `jeemitsha <jeemitsha@gmail.com>` only. Set locally, never globally. Verify with `git config user.email` before any commit.
- **GitHub account**: `jeemitsha`. Verify with `gh auth status` before push / PR ops.
- **Don't modify** `~/Codebase/personal/remodex/` — that's the unmodified upstream clone, used as protocol reference. If you need to patch upstream, do it in a fork (e.g. `~/Codebase/personal/remodex-fork/`).
- **Don't commit** `pairing.json`, fixture files with live sessionIds, or anything bearer-like — see `.gitignore`.

## File map (skim this, then go to STATE.md)

```
app/                          Expo client (the actual Android app)
├── app/                      expo-router routes (index = onboarding, scan, pair)
├── components/               OnboardingWelcomePage, PrimaryCapsuleButton, etc.
├── lib/
│   ├── protocol/             crypto, secureTransport, relayClient, identity,
│   │                         qr, trustedSessionResolve, extract (turn/thread parsers)
│   ├── state/                pendingPairing, savedPairing
│   ├── theme/tokens.ts       colors, font sizes, spacing (mirrors AppFont.swift)
│   ├── polyfills/crypto.ts   getRandomValues polyfill via expo-crypto
│   ├── icons.tsx             SF Symbol → MaterialCommunityIcons map
│   ├── sidebar.ts            project grouping + relative-time formatting
│   └── __fixtures__/         real captured bridge responses (gitignored — re-capture)
├── scripts/
│   └── capture-fixtures.ts   headless harness: pair + dump JSON-RPC responses
└── *.test.ts                 vitest unit tests next to source
relay-local/                  patched copy of upstream relay (?role= query fallback)
Docs/
├── STATE.md                  ← LIVING DOC — read this, update this
└── PROTOCOL.md               wire-format spec
```

## Cheatsheet — local dev / test loop

```bash
# Three terminals on the Mac (in this order):

# 1. Local patched relay
cd relay-local && BIND_HOST=0.0.0.0 PORT=9000 npm start

# 2. Bridge pointed at it (REMODEX_PRINT_PAIRING_JSON=1 if you need to capture fixtures)
remodex stop                                      # stop daemon if running
REMODEX_PRINT_PAIRING_JSON=1 \
REMODEX_RELAY=ws://127.0.0.1:9000/relay remodex up

# 3. Expo dev server (LAN — phone scans exp://<mac-lan-ip>:8081 in Expo Go)
cd app && npx expo start --lan

# Test loop (from app/):
npm test                # vitest, ~300ms, no phone needed
npm run typecheck       # tsc --noEmit
npm run capture         # re-captures fixtures (requires bridge + pairing.json)
```

## Where to update STATE.md

Every session that makes progress should append to `Docs/STATE.md`'s "session log" section with: date, what changed, what's next. Don't lose context between sessions.

## The two upstream artifacts

- **Our repo**: <https://github.com/jeemitsha/remodex-android>
- **Upstream relay PR**: <https://github.com/Emanuele-web04/remodex/pull/107> (12-line additive `?role=` query fallback)
