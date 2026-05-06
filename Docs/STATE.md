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
