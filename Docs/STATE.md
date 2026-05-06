# STATE.md — Living Project State

**Update this file at the end of every session** (or every meaningful checkpoint within one). Future agents read this first to know what's done, what's broken, what's next.

---

## Goal

Build a **production-quality, polished, third-party Android client** for the Remodex bridge protocol that:

1. Visually mirrors the iOS Remodex app (onboarding, sidebar, chat) as closely as practical for cross-platform RN.
2. Implements the full Remodex protocol (E2EE pairing + JSON-RPC application layer + streaming + approvals + push).
3. Stays Apache-2.0, attributable upstream, and keeps the upstream relay patch (`?role=` query fallback) in a clean PR that can be merged.
4. Eventually distributes as an installable APK via EAS Build, not just an Expo Go preview.

---

## Where we left off (most recent → oldest)

### 2026-05-06 — late night — model picker, context ring, image upload, voice, capture-cache, EAS docs

**Commits in this checkpoint** (newest first):
- `<latest>` EAS dev-build docs + eas.json + image-picker permissions in app.json
- `c765965` capture script remembers identity → second run uses trusted_session_resolve, no QR
- `8341fff` voice transcription via expo-audio + voice/resolveAuth + chatgpt.com/backend-api/transcribe; context pill is now a clean SVG progress ring (react-native-svg)
- `616e947` image attachments end-to-end (expo-file-system base64 → data URL → input[].image_url with `url`/`image_url` retry); also fixes session-list stall (model/list runs fire-and-forget) + pins active thread in sidebar so it never hides behind "Show all"
- `1797211` context-window pill via thread/contextWindow/read with token-count tolerance + tap-for-detail panel
- `b0446a7` real model picker driven by model/list — hierarchical sheet (Intelligence + Model + Speed) mirroring iOS ComposerRuntimeMenuControl, bolt icon when fast mode is on, sends model+effort+serviceTier with turn/start

**Wired and working** (validated logic + UI; phone-test blockers noted inline):
- Model picker (Intelligence / Model / Speed) — opens iOS-style hierarchical sheet, persists per-thread selection
- Context-window ring — color shifts green/amber/red, tap opens detail with raw token counts
- Image attachments — pick from library or camera, multi-select up to 8, base64-encoded into `input[].image_url`-or-`url` data URLs, retries on legacy bridges
- Voice mic — expo-audio HIGH_QUALITY (m4a) recording with timer + Stop/Cancel, two-step auth (`voice/resolveAuth` → POST chatgpt.com/backend-api/transcribe), text injected into composer
- Capture identity cache — first run uses pairing.json + writes cache; subsequent runs trustedSessionResolve to skip QR; `REMODEX_CAPTURE_RESET=1` wipes
- EAS dev-build runbook in Docs/EAS.md + eas.json with development/preview/production profiles

**Stubbed / deferred (with reason)**:
- **Component snapshot tests**: deliberately deferred. Vitest (node env) + RN component rendering needs jsdom + RN module mocks + JSX transforms — half-day of config wrangling. Our parser layer (where silent regressions happen — see the original "raw JSON in chat" bug) is fully fixture-tested. Visual regressions are loud (reload Expo Go, look). Revisit when we move to EAS dev build because we'll likely add jest-expo for native-module tests anyway.
- **Plan-mode JSON-RPC payload**: `planArmed` UI state is real but turn/start params don't yet send `collaborationMode: { mode: "plan", settings: ... }`. Need to mirror iOS `buildCollaborationModePayload` + a developer-instructions reference text.
- **m4a vs WAV for voice transcription**: Android records m4a, iOS records WAV. Whisper accepts both, so we send `audio/m4a`. If a future bridge build rejects the format we'll add a converter (or switch to PCM via lower-level recorder options).
- **Live model-picker / context-pill updates while a turn streams**: model picker is fetched once at session-load; context pill refreshes after each `turn/start` success. Should be event-driven once we capture a `context/usage/updated`-like notification.

**Test infra status**: 12 test files, **149** unit + fixture tests, all green in ~370ms. New: runtime (21), contextWindow (15), attachments (12), voice (14).

**Next chunks** (in order):
1. **Plan-mode collaborationMode payload** — wire iOS `buildCollaborationModePayload` so `planArmed` actually changes how the bridge runs the turn.
2. **Streaming events** — subscribe to bridge notifications so the chat updates live (instead of refetching `thread/turns/list` per send). Includes live `Worked for` wrapper that grows tool calls as they happen.
3. **Real-bridge captures** for runtime + contextWindow — replace the synthetic model-list fixture with a captured one to confirm the parser handles whatever spelling this bridge ships.
4. **EAS dev build (actual run)** — produce an APK so we can drop Expo Go and unblock react-native-quick-crypto / better audio modules.
5. **Component snapshot tests** (after EAS migration to jest-expo).

### 2026-05-06 — night — sidebar 5-per-project + iOS-parity composer

**Commits in this checkpoint** (newest first):
- `f9d5ead` iOS-parity composer card (attachments preview, plus menu with photo-library / camera / plan-mode, model pill stub, context pill stub, mic stub, arrow-up send) — closes the `qrcode`-as-send bug from the prior session's "Next chunks #1"
- `0318188` sidebar caps each project section at 5 threads with "Show all (N)" / "Show less" toggle (`applyGroupLimit` helper in `lib/sidebar.ts`)

**State of UI now**:
- Sidebar drawer: each project section shows the 5 most-recent threads + a `Show all (N)` row that toggles per-section expansion. Re-collapses with `Show less`. Per-section state stored in a `Set<groupKey>` so re-fetches don't lose it.
- Composer: rounded card (radius 26, matches iOS) containing optional attachments preview row + multi-line TextInput + bottom bar `[+] [Default ▾] [Plan?] (spacer) [—] [mic] [↑]`. Send button = arrow-up in a filled dark circle.
- "+" menu = bottom-sheet Modal with Plan toggle, Photo library, Take a photo (expo-image-picker — works in Expo Go).
- Attachments stay local (preview only). Tapping the model pill / mic / context pill shows an Alert explaining the wire-up status.

**Wired and working**:
- Photo library picker (multi-select up to `MAX_ATTACHMENTS_PER_TURN = 8`) + camera capture, both with on-demand permission prompts.
- Plan-mode armed/disarmed visible state.
- Send button enables on either non-empty text OR ≥1 attachment.

**Stubbed (need bridge protocol research before they're real)**:
- **Model picker**: `runtime/list-models` JSON-RPC method not captured. Pill shows "Default" placeholder, tap → Alert.
- **Context-window pill**: needs `context-window-usage` event capture from a live turn. Placeholder "—".
- **Voice/mic**: needs the `GPTVoiceTranscriptionManager` channel reverse-engineered (referenced in iOS Codex `Services/`). Tap → Alert.
- **Sending attachments to the bridge**: `input[]` payload shape for image attachments not in `Docs/PROTOCOL.md`. Today the picker just stores URIs in composer state; on send we strip them.

**Test infra status**: 8 test files, **86** unit + fixture-backed tests, all green in ~300ms. New: `lib/sidebar.test.ts` +5 cases for `applyGroupLimit`; `lib/composer-state.test.ts` 12 cases for the reducer + predicates.

**Next chunks** (in order, commit each):
1. **Capture `runtime/list-models`** — extend `scripts/capture-fixtures.ts` to call this method (or whatever the bridge actually exposes — confirm by reading `phodex-bridge` + iOS `CodexService+RuntimeConfig.swift`), then wire the model pill to a real picker sheet matching iOS's "Effort / Change model / Speed" sections. Persist the selection in `Status.thread-ready.modelLabel`.
2. **Capture context-window-usage** — find the JSON-RPC notification (likely `context/usage` or a field on `turn/started` / `turn/completed`), update `extract.ts` to surface it as `TurnMeta.contextUsage`, render it in the composer's ctx pill (token count + percent ring like iOS).
3. **Image attachments end-to-end** — research the input shape (suspect `{ type: 'image', image: { dataUrl } }` or signed-URL upload), wire send + show server-side echo on a fresh turn.
4. **Voice transcription** — read iOS `GPTVoiceTranscriptionManager.swift`, find the JSON-RPC method, add a tiny audio recorder (`expo-av`) + base64 upload.
5. **Persistent identity for `npm run capture`** — saved phone identity cache so subsequent fixture runs don't need a fresh QR.
6. **Component snapshot tests** — `@testing-library/react-native` snapshots for `Composer`, `WorkedForCard`, `ApprovalCard` against captured fixtures.
7. **EAS dev build** — installable APK; drops Expo Go dependency; opens the door for `react-native-quick-crypto` if perf ever matters.

### 2026-05-06 — late evening — proper "Worked for" turn wrapper, wall-clock duration, precise format

**Commits in this checkpoint** (newest first):
- `<latest>` precise `Xh Xm Xs` duration formatter — moved to `lib/format.ts`, 6 fixture-backed tests
- `d58b415` wall-clock turn duration via new `extractTurnMeta` (was summing tool durations only — under-reported; the bridge sends top-level `durationMs`)
- `5a36a21` "Worked for X" turn wrapper with sub-grouped tools (commands batch + MCP pills + steered prompts + intermediate narration)
- `f9b5b24` no agent bubbles, uniform user bubble, no top bar, tighter bullet indentation
- `2f063e2` first attempt at tool grouping + welcome+drawer + markdown

**State of UI now**:
- Default landing after auto-reconnect = welcome screen (green ✓ "Paired" + "Open sessions" CTA + ☰ button). NO sidebar visible.
- Sidebar slides in from left as overlay drawer (Animated translateX, 220ms). Tap backdrop or thread → close.
- Per-turn chat layout: `[user bubble right] → [Worked for {wall-clock} ▸] → [final answer plain markdown left]`.
- Inside expanded "Worked for": narration text (markdown), `▸ Ran N commands` collapsible (each command further expandable to show $cmd + output), `▸ Used Gmail` MCP pills, "Steered conversation" sub-prompts.
- Bullet list indentation 4× tighter than default react-native-markdown-display.
- Wall-clock duration is precise (`2m 49s` not `3m`).

**Open known issues**:
- The composer's send button still shows a `qrcode` SF Symbol icon by mistake (should be a paper plane / arrow).
- The capture script still requires a fresh QR + manual paste of `pairing.json` each run (no persistent identity yet).
- `assistant`-role text inside the assistant block uses our default-fontSize body. Headings render but the visual hierarchy in the captured fixture (which has `### Latest Status` etc.) could be tightened more.
- Tool calls happening RIGHT NOW (live streaming) don't yet appear inside a "Worked for" wrapper because we only build the wrapper from completed turn metadata. Fine for MVP.

**Test infra status**: 7 test files, 69 unit + fixture-backed tests, all green in ~300ms. Capture script + fixture corpus working — re-capture with `REMODEX_CAPTURE_THREAD_IDS=<id>,...` to refresh.

**Next chunks** (in order, commit each):
1. **Composer send-icon fix** — replace the `qrcode` icon with a proper send icon (`Icon` mapping → `send` or `arrow.up.circle`).
2. **Persistent identity for `npm run capture`** — save phone identity to `app/lib/__fixtures__/.identity.cache.json` (gitignored), use `trustedSessionResolve` on subsequent runs, no QR needed.
3. **Component snapshot tests** — set up `@testing-library/react-native`, snapshot `MessageBubble` / `WorkedForCard` / `CommandsBatch` / `ApprovalCard` against the captured turn-display structure.
4. **Streaming tool-call grouping** — when the user sends a prompt, accumulate intermediate `agentMessage`/`commandExecution` notifications into a live `Worked for` wrapper that updates as events stream in. Currently the live stream only shows raw `streamingText` for the final assistant text.
5. **EAS dev build** — installable APK; drops Expo Go dependency; opens the door for `react-native-quick-crypto` if perf ever matters.
6. **Polish** — proper send-icon (paper plane), highlight active thread inside drawer (already done, verify), pull-to-refresh on sessions list, better empty states.

### 2026-05-06 — evening — tool grouping + welcome+drawer + markdown (commit `2f063e2`)

**User feedback addressed**:
- ✅ Chronological message order (was inverted, now top-down)
- ✅ Tool calls collapsed by default — `Worked for {duration} · {N} steps` row, expandable; each child further expandable for command+output. Mirrors iOS Codex.
- ✅ Welcome screen as default + drawer sidebar — no sidebar visible on launch; hamburger toggles it; tapping a thread closes drawer + opens thread.
- ✅ Real markdown rendering via `react-native-markdown-display` for assistant text (lists, headings, bold, inline code, fenced code, blockquotes, tables, hr — all themed to our dark tokens).
- ✅ mcpToolCall properly extracted: `server.tool` as title, `result` as output, `error` inline, `durationMs` shown.

**To test on phone**: reload Expo Go (shake → Reload). Pairing flow unchanged. Once paired:
- Welcome screen with green ✓ bubble + "Paired with {fingerprint}" + "Open sessions" CTA
- Tap CTA or ☰ → sidebar slides in from left
- Pick a thread → drawer closes, chat loads
- Tool calls appear as a single "Worked for Xs" row at the spot they happened in the conversation; tap to expand
- Assistant markdown should now render (not raw)
- Send a prompt → optimistic user bubble at bottom + streaming assistant bubble below

**New artifacts**:
- `lib/group-turns.ts` (+ tests) — turn list → display item list with consecutive tool packing
- `WelcomeView`, `SidebarDrawer`, `ToolGroupCard`, `ToolGroupChild` components in pair.tsx
- `markdownStyles` in pair.tsx — dark theme tokens applied to react-native-markdown-display
- `extract.ts` mcpToolCall handling

**Captured fixtures now include**:
- `thread-list.response.json` (top-of-list)
- `thread-turns-list.response.json` (specific session `019dfc7c-...` requested by user — has 19 commandExecutions + 4 mcpToolCalls + 10 agentMessages + 3 userMessages, good torture-test data)

**Capture script enhancements**:
- `REMODEX_CAPTURE_THREAD_IDS=<id1>,<id2>` to pin specific sessions; first id is canonical fixture, others get `thread-turns-list.<shortid>.response.json`.
- Limit raised from 5 to 200 turns per capture.

**Next chunks** (in order, commit each):
1. **Validate on phone** — does tool grouping look right? Markdown render correctly? Drawer feel right?
2. **Component snapshot tests** — finally set up `@testing-library/react-native` so `MessageBubble`, `ToolGroupCard`, `CommandCard`, `ApprovalCard` get tested against fixtures. Catches "raw JSON came back" silently.
3. **Streaming live-bubble polish** — make the assistant streaming text use the same MessageBubble look (markdown + bubble shape + caret).
4. **Composer polish** — paper-plane icon (currently sends a qrcode SF Symbol by accident), tap-outside-to-dismiss, history scroll-to-bottom on send.
5. **Persistent identity for `npm run capture`** — add an identity-cache file so subsequent runs use trusted_reconnect without needing a fresh QR each time. Avoids the "kill bridge to capture" disruption.
6. **EAS dev build** (post-MVP) — installable APK, drops Expo Go dependency.

### 2026-05-06 — late afternoon — UI rebuild against fixture-backed parsers (commit `cac2c4d`)

**Just shipped**:
- `pair.tsx` now imports `extractThreads` / `extractTurns` from `lib/protocol/extract.ts`. The wrong inline parsers are gone.
- **Chat bubbles**: user right-aligned in plan-blue tinted bubble with rounded-top-right; assistant left-aligned in subtle dark bubble.
- **Mini-markdown**: bubbles parse triple-backtick fenced code blocks (with optional language tag) and render them in a horizontally-scrollable monospace box. Other markdown deferred (would need `react-native-markdown-display`).
- **Command-execution cards** (tool role): terminal-icon header, project-cwd label, `$ <command>` mono line, scrollable output (collapsible past 8 lines), green ✓ "completed" / red ✕ "exit N" status pill, duration label.
- **System / reasoning rows**: dimmed italic, role label uppercased.
- **Sidebar row** uses real `preview` field as subtitle (much better than the old "completed" status). Added `branch` pill from `gitInfo.branch`.

**Still 51/51 tests green** (sidebar, qr, crypto, extract).

**To test on phone**: reload Expo Go (shake → Reload). Trusted-session-resolve should auto-reconnect using the saved pairing (which points at the local relay we set up earlier). Then tap a thread — you should see a real chat layout, not raw JSON.

**Currently running locally** (so phone can pair):
- Local patched relay on `ws://127.0.0.1:9000/relay` (PID may vary)
- Bridge connected to it (started via `REMODEX_RELAY=ws://127.0.0.1:9000/relay remodex up`)
- Expo dev server on `exp://192.168.29.10:8081`
- Daemon (`remodex run-service` on public relay) is **stopped** — restart with `remodex start` if you want the public relay back instead.

**Next chunks** (do these in order, commit each):
1. **Validate on phone** — does the chat UI now look right? Are there other issues to fix?
2. **Real markdown rendering** for assistant messages — install `react-native-markdown-display`, replace the minimal fence parser. Tradeoff: ~50KB bundle increase, but bullet lists / headings / inline code all start working. Worth it.
3. **Snapshot tests** — set up `@testing-library/react-native` and add tests that render `MessageBubble` / `CommandCard` / `ApprovalCard` against the fixtures. Catches "regressed JSON-dump" silently.
4. **Compose UX polish**: send button shows ✈ icon (currently uses qrcode by accident), enter-to-send option, clear input on send (already done), optimistic user-message styling matches confirmed bubble.
5. **Streaming chat polish**: while assistant streams, we now insert it as a "live" header above the timeline; that needs a real bubble look matching finalized assistant rows.
6. **EAS dev build** — APK we can install standalone, drop the Expo Go dependency. Also unlocks `react-native-quick-crypto` if perf becomes a concern.

### 2026-05-06 — afternoon — automated test loop landed; parsers being fixed against real fixtures

**Just shipped**:
- Vitest test infrastructure (`vitest.config.ts`, `npm test`, `npm run test:watch`).
- Headless integration harness (`scripts/capture-fixtures.ts`) that pairs against the live bridge and dumps real JSON-RPC responses to `lib/__fixtures__/*.response.json`.
- Captured first set of real fixtures (`thread-list`, `thread-turns-list`, `initialize`).
- New `lib/protocol/extract.ts` with **fixture-backed correct extractors** for `extractThreads` / `extractTurns`. Replaces the wrong permissive parser that was previously inline in `pair.tsx` (which dumped raw JSON into the timeline because it was looking for `userInput`/`assistantOutput` fields that don't exist in the upstream wire format).
- Protocol shape now correctly understood:
  - **Threads**: `{ id, name, preview, cwd, source, status: { type: ... }, createdAt/updatedAt as SECONDS, gitInfo: { branch, sha, originUrl }, ... }`. NOT `title`. NOT a string status.
  - **Turns**: `{ id, items: [...] }` where each item has `type` ∈ `{ userMessage, agentMessage, commandExecution, fileChange, reasoning, toolCall, ... }`. `userMessage.content[].text`, `agentMessage.text` (top-level), `commandExecution` is its own card with `command`, `aggregatedOutput`, `exitCode`, `durationMs`.
- 51 unit tests, all green in ~300ms (sidebar, qr, crypto, extract).

**In flight (paused mid-task)**:
- Tasks 6-10 from the prior batch shipped *code* but the user reported it "sucks" — raw JSON in chat, sidebar weak. Root cause was the wrong parser. **`extract.ts` fixes the parser side; `pair.tsx` still imports the old inline parser** and needs to be wired to `extract.ts`.
- Visual fidelity in `pair.tsx` thread detail view is functional but ugly: tool calls render as plain text, no code styling, no exit-code badge, no chat bubbles, no markdown for assistant messages.

**Next chunks (do these in order, commit each)**:
1. **Wire `pair.tsx` to `extract.ts`**: delete the inline `extractTurns`/`extractThreads`/`pickString`/`pickText` from pair.tsx, import the new ones. Take care: the new TurnRow type adds tool-call extras (`command`, `toolStatus`, `exitCode`, etc.) that the chat renderer should use to render command-execution cards instead of raw text.
2. **Rebuild thread detail UI** to look like a real chat:
   - User messages right-aligned in plan-blue bubbles; assistant left-aligned.
   - Markdown rendering for assistant text (`react-native-markdown-display` or similar) — code blocks should be monospace with a subtle background.
   - **Command-execution cards**: terminal-style box with `$ <command>`, scrollable output snippet, status pill (✓ exit 0 / ✕ exit N), duration. Don't dump JSON.
   - File-change cards: filename + +N / −M diff stats.
   - Reasoning rows: collapsible / dimmed.
3. **Polish sidebar** using the real fields now available (`preview`, `branch`, `gitInfo`, status object). Add: preview as subtitle, branch indicator, source icon (vscode/cli/exec).
4. **Snapshot tests for components** — set up `@testing-library/react-native` so we can assert the chat renders correctly without needing a phone.
5. **EAS dev build** — get an installable APK so we can use `react-native-quick-crypto` if perf becomes an issue, plus drop the Expo Go dependency.

### 2026-05-06 — afternoon (earlier) — tasks 6-10 + upstream PR

10 tasks committed, all visible in `git log`. Upstream PR #107 opened. README written. **Quality of tasks 6-10 was not validated against real data — that's why we hit the "raw JSON" problem and pivoted to the test loop above.**

### 2026-05-06 — morning — milestones 1 + 2

Pairing handshake working end-to-end on Android via Expo Go. 50+ live threads rendered. (Validated by the user.)

---

## Current status checklist

### Works on phone (validated by user)

- [x] 5-page onboarding flow
- [x] QR scan + pairing handshake (qr_bootstrap + trusted_reconnect)
- [x] Encrypted JSON-RPC channel
- [x] `initialize` + `thread/list` → renders threads (50+ shown)
- [x] Persisted phone identity, persisted pairing, auto-reconnect on launch
- [x] `trusted-session-resolve` HTTP fallback (no re-pair needed across bridge restarts)

### Code shipped but quality unconfirmed / needs rework

- [ ] Tap thread → render turns (rendering is wrong — uses old inline parser; raw JSON shows up)
- [ ] Compose + send a prompt with streaming (untested by user; should work after parser fix)
- [ ] Approve / reject tool calls (untested by user)
- [ ] iOS-fidelity sidebar (status dots / sections / timing landed but row content uses wrong fields, e.g. assumes `title` instead of `name`)

### Not yet started

- [ ] Markdown rendering for assistant messages (`react-native-markdown-display`)
- [ ] Real chat-bubble layout (user right, assistant left)
- [ ] Command-execution cards (terminal block + status pill + exit code + duration)
- [ ] File-change cards (filename + diff stats)
- [ ] Reasoning collapsible row
- [ ] Image attachments (camera + photo picker → input[].image_url)
- [ ] Push notifications (needs upstream relay extension for FCM)
- [ ] Plan mode toggle in composer
- [ ] EAS dev build → installable APK
- [ ] Component snapshot tests via @testing-library/react-native

---

## Test loop — how to iterate without a phone

```bash
# From app/:
npm test          # all unit + fixture tests, ~300ms
npm run typecheck # tsc --noEmit
npm run capture   # refresh real-bridge fixtures (needs bridge + pairing.json — see below)
```

To re-capture fixtures (e.g. after upstream protocol change):

1. Stop daemon: `remodex stop`
2. Start bridge against local relay with QR debug: `REMODEX_PRINT_PAIRING_JSON=1 REMODEX_RELAY=ws://127.0.0.1:9000/relay remodex up`
3. Copy the printed JSON line (`{"v":2,"relay":...}`) to `app/pairing.json`
4. `cd app && npm run capture`
5. Inspect `lib/__fixtures__/*.response.json`
6. Update tests / parsers as needed

The capture script uses an ephemeral phone identity each run, so it doesn't pollute the bridge's trusted-phone registry.

---

## Known gotchas (carried forward from prior sessions)

1. **Expo Go strips custom WebSocket request headers.** That's why we patched the relay to accept `?role=android` query string. Both the local `relay-local/` copy and the upstream PR (#107) have this.
2. **Noble v2 renamed** `randomPrivateKey` → `randomSecretKey`. Don't forget when reading old examples.
3. **Subpath imports** from `@noble/*` need `.js` extensions (e.g. `@noble/curves/ed25519.js`, `@noble/hashes/sha2.js` — `sha256.js` doesn't exist, use `sha2.js`).
4. **`crypto.getRandomValues`** is polyfilled via `expo-crypto.getRandomBytes` (see `lib/polyfills/crypto.ts`). Don't reach for `react-native-get-random-values` — needs an EAS build.
5. **`thread/turns/list` params**: `{ threadId, limit, sortDirection: 'desc' }` (NOT `{ threadId, cursor: null }` first call). Plus the response is `result.data` (not `result.turns`).
6. **`initialize` params** have a `clientInfo` object — we send `name: "remodex_android"`. The bridge gates the iPhone-app version (≥ 1.5) but for now we don't need to send `iosAppVersion` at the JSON-RPC level; that gate is in the secure-transport layer where we send `iosAppVersion: "1.5"` in `clientHello`.
7. **`commandExecution` items** have `aggregatedOutput` (not `output`), `exitCode` (number), `durationMs`. Status comes back as a string like `"completed"`.
8. **Bridge state files**: `~/.remodex/daemon-config.json` (relay URL), `~/.remodex/device-state.json` (trusted phones).

---

## Decisions made (and the why)

- **Path A**: separate repo for the Android client, small upstream PR for the relay patch only. Whole-app PR upstream rejected as too risky given upstream's "not accepting contributions yet" stance.
- **Pure-JS noble crypto** over `react-native-quick-crypto`: keeps Expo Go compatibility, avoids an EAS dev-build prerequisite during early iteration. Swap if perf matters later (it shouldn't — we encrypt a handful of envelopes/sec, not millions).
- **Inline thread-detail in `pair.tsx`** instead of a separate route: keeps the live `RelayClient` ownership simple, avoids React Context plumbing. Will refactor to multi-route once the UX is proven.
- **Vitest** (not Jest) for tests: native TS support, faster, no Babel preset wrangling.
- **Fixture-driven parser tests**: every wire-format claim must be backed by a captured fixture, not a guess from reading iOS Swift.

---

## Repos / artifacts

- **This repo**: <https://github.com/jeemitsha/remodex-android> (`main` branch is what runs)
- **Upstream**: <https://github.com/Emanuele-web04/remodex>
- **Upstream PR (relay patch)**: <https://github.com/Emanuele-web04/remodex/pull/107>
- **Local fork for the PR**: `~/Codebase/personal/remodex-fork/` (branch `relay/accept-role-from-query-string`)

---

## Session log (append; don't rewrite history)

- **2026-05-06 morning**: scaffolded Expo, audit, protocol spec, milestones 1+2 (pair + thread list, validated on phone).
- **2026-05-06 early afternoon**: tasks 6-10 (thread detail, compose, approval, reconnect, sidebar fidelity); upstream PR #107 opened. *Quality not yet validated; user reported regressions in next session.*
- **2026-05-06 mid afternoon**: pivoted to test infrastructure (vitest + capture harness + fixture-backed parsers in `extract.ts`). 51 unit tests pass. Old inline parsers in `pair.tsx` not yet swapped — that's the next step.
- **2026-05-06 late afternoon**: swapped `pair.tsx` parsers to use `extract.ts`; rebuilt thread-detail UI as chat bubbles + command-execution cards; sidebar now shows preview + branch pill. Commit `cac2c4d`. Awaiting user phone validation.
- **2026-05-06 evening**: chronological turn order fix; collapsible tool groups (lib/group-turns.ts); welcome+drawer layout pattern; react-native-markdown-display for assistant text; mcpToolCall extraction. Commit `2f063e2`. 57/57 tests.
- **2026-05-06 late evening**: proper "Worked for X" turn wrapper (`lib/turn-display.ts`); per-turn structure with narration / commands-batch / mcp-pill / steered blocks; no-bubble assistant; uniform user bubble; tight bullet indent; removed top-only-back-arrow bar; wall-clock turn duration via `extractTurnMeta`; precise `Xh Xm Xs` formatter in `lib/format.ts`. 69/69 tests. Awaiting user phone validation.
- **2026-05-06 night**: sidebar each-project-cap-5 + Show all toggle (`applyGroupLimit` in `lib/sidebar.ts`); iOS-parity composer card with attachments preview, plus-menu (photo library + camera via expo-image-picker, plan-mode toggle), model pill stub, context pill stub, mic stub, arrow-up send. Closes the qrcode-as-send bug. 86/86 tests. Commits `0318188`, `f9d5ead`. Awaiting user phone validation.
- **2026-05-06 late night**: real model picker (model/list, hierarchical sheet, bolt icon when fast); context-window ring (thread/contextWindow/read, react-native-svg arc); image attachments end-to-end (expo-file-system base64 → input[].image_url with retry); voice transcription (expo-audio + voice/resolveAuth + chatgpt.com transcribe); fixed the model/list bootstrap stall + pinned active thread in sidebar. Capture script identity cache → no-QR refreshes. EAS docs + eas.json. 149/149 tests. Commits `b0446a7`, `1797211`, `616e947`, `8341fff`, `c765965`, plus EAS docs commit.
