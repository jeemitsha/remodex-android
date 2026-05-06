# Remodex Bridge ↔ Phone Protocol Spec (v1, derived from upstream v1.5.0)

Reverse-engineered from `~/Codebase/personal/remodex/phodex-bridge/src/secure-transport.js` and `CodexMobile/CodexMobile/Services/CodexService+SecureTransport.swift` on 2026-05-06. Apache-2.0 source. **Authoritative source is the upstream code, not this doc.**

## Architecture

```
[Android client]  ⇄  [Relay WebSocket server]  ⇄  [phodex-bridge on Mac]
   (this project)        (Emanuele-hosted or                ↓ stdio JSON-RPC
                          self-hosted from                  [codex app-server]
                          remodex/relay/)
```

- Both phone and Mac connect *outbound* as WebSocket clients to the same relay URL, keyed by `sessionId`.
- Relay is a passive matchmaker; **it sees only encrypted envelopes** after handshake.
- All application traffic is JSON-RPC 2.0 (Codex's `app-server` protocol) tunneled inside an E2EE envelope.
- Public Remodex npm package ships with NO embedded relay URL — `prepare-private-defaults.js` and `cleanup-private-defaults.js` strip it before publish. Operators must set `REMODEX_RELAY` env var or self-host.

## Constants

| Name | Value |
|---|---|
| `PAIRING_QR_VERSION` | `2` |
| `SECURE_PROTOCOL_VERSION` | `1` |
| `HANDSHAKE_TAG` | `"remodex-e2ee-v1"` |
| `MAX_PAIRING_AGE_MS` | `300_000` (5 min) |
| `MIN_IOS_APP_VERSION` (gated by bridge ≥ 1.3.9) | `"1.5"` — our Android client must claim ≥ this in `clientHello` |
| Outbound replay buffer | 500 messages / 10 MB |
| Short pairing code alphabet | `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (Crockford-ish, no I/O/0/1) |

## Pairing QR payload (v2)

QR encodes a JSON string:

```json
{
  "v": 2,
  "relay": "wss://relay.example/...",
  "sessionId": "<uuid-ish, bearer-like>",
  "macDeviceId": "<persistent Mac ID>",
  "macIdentityPublicKey": "<base64 Ed25519 pubkey>",
  "expiresAt": 1714000000000
}
```

5-min TTL on `expiresAt`. There's also a separate 10-char `pairingCode` printed alongside — same alphabet as constants, used for manual fallback when QR scanning fails.

Anyone holding this JSON can attempt the bridge handshake within 5 min — treat it as a bearer secret.

## Crypto primitives

All from Node `crypto` / Apple CryptoKit. **Maps 1:1 to `react-native-quick-crypto` for our Expo port.**

| Purpose | Algorithm |
|---|---|
| Identity (long-term, per device) | Ed25519 (signing) |
| Ephemeral (per handshake) | X25519 (Curve25519 ECDH) |
| Transcript hash / KDF salt | SHA-256 |
| Symmetric envelope | AES-256-GCM |
| Key derivation | HKDF-SHA256 |
| Random nonces | 32 bytes from CSPRNG |

Two AES keys are derived from the X25519 shared secret:
- `phoneToMacKey = HKDF-SHA256(sharedSecret, salt=SHA256(transcript), info="${HANDSHAKE_TAG}|${sessionId}|${macDeviceId}|${phoneDeviceId}|${keyEpoch}|phoneToMac")` (32 bytes)
- `macToPhoneKey = HKDF-SHA256(..., info="...|macToPhone")` (32 bytes)

## Handshake sequence (4 messages, all `kind`-tagged JSON over WebSocket)

```
phone                             mac
  │      clientHello                │   (1)
  │ ───────────────────────────────►│
  │      serverHello                │   (2) signed by mac identity Ed25519
  │ ◄───────────────────────────────│
  │      clientAuth                 │   (3) signed by phone identity Ed25519
  │ ───────────────────────────────►│
  │      secureReady                │   (4)
  │ ◄───────────────────────────────│
  │      resumeState  (optional)    │   (5) — only for trusted_reconnect
  │ ───────────────────────────────►│
  ▼              encrypted envelopes from here on
```

### (1) clientHello (phone → mac)

```json
{
  "kind": "clientHello",
  "protocolVersion": 1,
  "sessionId": "<from QR>",
  "handshakeMode": "qr_bootstrap" | "trusted_reconnect",
  "phoneDeviceId": "<phone-generated, persistent>",
  "phoneIdentityPublicKey": "<base64 Ed25519 pubkey>",
  "phoneEphemeralPublicKey": "<base64 X25519 pubkey, fresh per handshake>",
  "clientNonce": "<base64 32-byte random>"
}
```

`handshakeMode`:
- **First pair after QR scan** → `qr_bootstrap` (must occur within 5 min `expiresAt`).
- **Subsequent reconnects** to a Mac whose identity key is already trusted → `trusted_reconnect`.

### (2) serverHello (mac → phone)

```json
{
  "kind": "serverHello",
  "protocolVersion": 1,
  "sessionId": "...",
  "handshakeMode": "qr_bootstrap" | "trusted_reconnect",
  "macDeviceId": "...",
  "macIdentityPublicKey": "<base64 Ed25519>",
  "macEphemeralPublicKey": "<base64 X25519>",
  "serverNonce": "<base64 32 bytes>",
  "keyEpoch": 1,
  "expiresAtForTranscript": <ms epoch | 0 for trusted_reconnect>,
  "macSignature": "<base64 Ed25519 sig over transcriptBytes>",
  "clientNonce": "<echoed back>"
}
```

Phone MUST verify `macIdentityPublicKey` matches the QR's `macIdentityPublicKey` (qr_bootstrap) or the trusted record (trusted_reconnect), and verify `macSignature` against `transcriptBytes` (built locally — see below).

### (3) clientAuth (phone → mac)

```json
{
  "kind": "clientAuth",
  "sessionId": "...",
  "phoneDeviceId": "...",
  "keyEpoch": 1,
  "phoneSignature": "<base64 Ed25519 sig over (transcriptBytes ++ length_prefixed_utf8('client-auth'))>"
}
```

Mac verifies signature with `phoneIdentityPublicKey` from the original clientHello.

### (4) secureReady (mac → phone)

```json
{
  "kind": "secureReady",
  "sessionId": "...",
  "keyEpoch": 1,
  "macDeviceId": "..."
}
```

After this, both sides derive the two AES-256-GCM keys (formula above).

### (5) resumeState (phone → mac, optional)

```json
{
  "kind": "resumeState",
  "sessionId": "...",
  "keyEpoch": 1,
  "lastAppliedBridgeOutboundSeq": 42
}
```

Tells the Mac "I last applied bridge-outbound message #42, replay everything after that." This is the magic that makes "see active sessions after reconnect" work — the bridge's outbound buffer (last 500 msgs / 10 MB) re-streams missed events.

## Transcript bytes (length-prefixed concatenation)

```
HANDSHAKE_TAG ("remodex-e2ee-v1")  ─┐
sessionId                           │
String(protocolVersion)             │  Each field encoded as:
handshakeMode                       │   uint32_be(byteLength) || rawBytes
String(keyEpoch)                    │  Strings are UTF-8.
macDeviceId                         │  Public keys are decoded from base64
phoneDeviceId                       │  to raw bytes before length-prefixing.
macIdentityPublicKey (raw)          │
phoneIdentityPublicKey (raw)        │
macEphemeralPublicKey (raw)         │
phoneEphemeralPublicKey (raw)       │
clientNonce (raw 32B)               │
serverNonce (raw 32B)               │
String(expiresAtForTranscript)     ─┘
```

`expiresAtForTranscript` is the QR's `expiresAt` for `qr_bootstrap`, otherwise `0`.

## Encrypted envelope (post-handshake, both directions)

Wire frame:

```json
{
  "kind": "encryptedEnvelope",
  "v": 1,
  "sessionId": "...",
  "keyEpoch": 1,
  "sender": "iphone" | "mac",
  "counter": 0,
  "ciphertext": "<base64 AES-256-GCM ciphertext>",
  "tag": "<base64 16-byte AES-GCM tag>"
}
```

Decryption:
- Use `phoneToMacKey` if `sender == "iphone"`, else `macToPhoneKey`.
- AAD: none.
- Nonce: 12 bytes, `nonce[0] = 1 (mac sender) | 2 (iphone sender)`, `nonce[1..11] = counter` as big-endian (88-bit, plenty for session lifetime).
- Replay protection: each side rejects `counter <= lastInboundCounter`; counter increments per outbound message.

Decrypted plaintext is JSON:

```json
{
  "bridgeOutboundSeq": 42,        // present only for mac→phone, app-level seq for replay
  "payloadText": "<JSON-RPC 2.0 message string>"
}
```

`payloadText` itself is a stringified JSON-RPC envelope:
```json
{ "jsonrpc": "2.0", "method": "thread/turns/list", "id": 7, "params": { ... } }
```
or notification/response forms.

## Application-layer methods (incomplete, from grep of bridge.js)

Most go straight through to `codex app-server`; bridge intercepts a few (account/voice). Notes from upstream's CLAUDE.md are essential reading; below is the surface seen so far.

**Lifecycle**
- `initialize` (request) / `initialized` (notification) — JSON-RPC capability handshake to `codex app-server`

**Threads (≈ Codex sessions)**
- `thread/start` / `thread/started` — create a new Codex session
- `thread/read` — pull latest state of a thread
- `thread/turns/list` — list all turns in a thread (paginated)
- `thread/name/updated` — server-pushed name change
- `thread/tokenUsage/updated` — server-pushed usage tick

**Turns (a single user→assistant exchange)**
- `turn/start` / `turn/started` — kick off a turn (note: `turn/started` may not include `turnId`; client must keep a per-thread fallback)
- `turn/completed` — turn finished
- (More to map: approval, steering, queue, plan-mode, file events — not yet read)

**Account / auth (intercepted by bridge, NOT forwarded to codex)**
- `account/status/read` (also legacy `getAuthStatus`)
- `account/login/openOnMac`
- `account/login/completed`
- `account/updated`
- `voice/resolveAuth`

**Image attachments**: bridge sanitizes thread history to strip inline-image data URLs before forwarding (cost/transport); we'll need to handle re-fetching if we render images. See `sanitizeThreadHistoryImagesForRelay` in bridge.js:800.

## Error frames

```json
{ "kind": "secureError", "code": "<known code>", "message": "<human msg>" }
```

Known codes (from secure-transport.js):
- `update_required`, `invalid_client_hello`, `invalid_handshake_mode`, `pairing_expired`, `phone_not_trusted`, `phone_identity_changed`, `invalid_client_nonce`, `unexpected_client_auth`, `invalid_client_auth`, `invalid_phone_signature`, `secure_channel_unavailable`, `invalid_envelope`, `decrypt_failed`, `invalid_payload`

## Implementation checklist for the Expo client

In dependency order — each ticked box should produce a manually testable result against the running `remodex` bridge on this Mac.

- [ ] WebSocket client to `relayUrl` with sessionId routing — empty echo only, no crypto yet
- [ ] Generate phone identity Ed25519 keypair on first run, store in `expo-secure-store` (Android Keystore-backed)
- [ ] Persist `phoneDeviceId` (UUID) alongside identity keys
- [ ] QR scanner via `expo-camera` decoding the QR JSON — extract relay URL, sessionId, macIdentityPublicKey, expiresAt
- [ ] Implement `buildTranscriptBytes` — exact byte-for-byte length-prefix format (length is uint32_be, NOT varint)
- [ ] Send `clientHello`, wait for `serverHello`, verify `macSignature` and identity-key match against QR
- [ ] Send `clientAuth` with Ed25519 signature over `transcriptBytes ++ length_prefixed("client-auth")`
- [ ] Wait for `secureReady`, derive both AES keys with HKDF-SHA256
- [ ] Send `resumeState` with `lastAppliedBridgeOutboundSeq = 0` on first connect
- [ ] Implement `encryptEnvelope` / `decryptEnvelope` with the 12-byte direction-prefixed counter nonce
- [ ] Wrap JSON-RPC sends, route incoming envelopes by `id` for request/response correlation
- [ ] Send `initialize` (mimicking iOS app's capabilities), wait for response
- [ ] Send `thread/turns/list` or whatever returns the active session list — render in UI
- [ ] **MILESTONE**: Android phone shows the same session list the iPad currently shows

After that milestone the rest is UI polish: chat stream rendering, approval buttons, image handling, git actions, queue, etc.

## Open questions to resolve while building

1. Where does the relay URL come from — does the user need to run their own from `relay/`, or does Emanuele expose a public one for App Store users? The QR you scanned earlier has the answer; check `~/.remodex/state.json` (or wherever the bridge persists pairing state).
2. The bridge's `iosAppVersion` gate is checked via... how exactly? We see `MINIMUM_SUPPORTED_IOS_APP_VERSION = "1.5"` but I haven't yet found which message field carries it. Search needed.
3. `initialize` request schema — Codex's `app-server` protocol exposes capabilities/config. We need to read that from `codex-transport.js` or just observe the iOS app's traffic via the bridge's debug log.
4. Approval message shape: `CodexApprovalResponsePayloadTests.swift` exists — read it to learn the schema before implementing the approval UI.
