// Phone-side handshake driver and envelope codec. Mirrors:
//   bridge:    phodex-bridge/src/secure-transport.js
//   iOS:       CodexMobile/CodexMobile/Services/CodexService+SecureTransport.swift
//
// Drives the four-message handshake, derives AES keys, and exposes
// encrypt/decrypt for the encrypted application channel. Stateless w.r.t.
// I/O — caller wires it to a WebSocket via onWire / sendWire callbacks.

import { PhoneIdentity } from './identity';

// Subset of the QR pairing payload that the secure-transport handshake
// actually needs. Both fresh QR scans (PairingPayload) and saved pairings
// (SavedPairing) satisfy this shape.
export type PairingContext = {
  relay: string;
  sessionId: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
};

export type HandshakeMode = 'qr_bootstrap' | 'trusted_reconnect';
import {
  SECURE_PROTOCOL_VERSION,
  SENDER_IPHONE,
  SENDER_MAC,
  buildTranscriptBytes,
  bytesToBase64,
  clientAuthTranscript,
  decryptGCM,
  deriveAesKey,
  ed25519Sign,
  ed25519Verify,
  encryptGCM,
  generateX25519KeyPair,
  random32,
  sha256Bytes,
  utf8Bytes,
  x25519SharedSecret,
} from './crypto';

const HANDSHAKE_TAG = 'remodex-e2ee-v1';

// ---------- Wire-message types ----------

export type ClientHello = {
  kind: 'clientHello';
  protocolVersion: number;
  sessionId: string;
  handshakeMode: HandshakeMode;
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneEphemeralPublicKey: string;
  clientNonce: string; // base64
  // Bridge gates iPhone-app version >= 1.5 starting at bridge 1.3.9.
  // We claim 1.5 to be admitted; renegotiation as Android is post-MVP.
  iosAppVersion: string;
};

export type ServerHello = {
  kind: 'serverHello';
  protocolVersion: number;
  sessionId: string;
  handshakeMode: string;
  macDeviceId: string;
  macIdentityPublicKey: string;
  macEphemeralPublicKey: string;
  serverNonce: string; // base64
  keyEpoch: number;
  expiresAtForTranscript: number;
  macSignature: string; // base64
  clientNonce: string; // echoed back
};

export type ClientAuth = {
  kind: 'clientAuth';
  sessionId: string;
  phoneDeviceId: string;
  keyEpoch: number;
  phoneSignature: string; // base64
};

export type SecureReady = {
  kind: 'secureReady';
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
};

export type SecureError = {
  kind: 'secureError';
  code: string;
  message: string;
};

export type EncryptedEnvelope = {
  kind: 'encryptedEnvelope';
  v: number;
  sessionId: string;
  keyEpoch: number;
  sender: 'iphone' | 'mac';
  counter: number;
  ciphertext: string;
  tag: string;
};

export type ResumeState = {
  kind: 'resumeState';
  sessionId: string;
  keyEpoch: number;
  lastAppliedBridgeOutboundSeq: number;
};

// ---------- Public state machine ----------

export type SecureSession = {
  sessionId: string;
  keyEpoch: number;
  macDeviceId: string;
  macIdentityPublicKey: string;
  phoneToMacKey: Uint8Array;
  macToPhoneKey: Uint8Array;
  lastInboundCounter: number;
  nextOutboundCounter: number;
};

type Pending = {
  pairing: PairingContext;
  identity: PhoneIdentity;
  ephemeralPriv: Uint8Array;
  ephemeralPubBase64: string;
  clientNonce: Uint8Array;
  handshakeMode: HandshakeMode;
};

export type HandshakeStage =
  | 'idle'
  | 'sending-client-hello'
  | 'awaiting-server-hello'
  | 'sending-client-auth'
  | 'awaiting-secure-ready'
  | 'paired'
  | 'failed';

export type HandshakeEvent =
  | { type: 'stage'; stage: HandshakeStage }
  | { type: 'paired'; session: SecureSession }
  | { type: 'error'; message: string; code?: string };

export type SecureTransport = {
  start: () => void;
  handleWireText: (text: string) => void;
  encryptApplication: (payloadText: string) => string;
  decryptApplication: (envelope: EncryptedEnvelope) => string | null;
  isPaired: () => boolean;
};

const IOS_APP_VERSION_TO_CLAIM = '1.5';

export function createSecureTransport(opts: {
  pairing: PairingContext;
  identity: PhoneIdentity;
  handshakeMode?: HandshakeMode;
  sendWire: (text: string) => void;
  emit: (event: HandshakeEvent) => void;
}): SecureTransport {
  const handshakeMode: HandshakeMode = opts.handshakeMode ?? 'qr_bootstrap';
  let pending: Pending | null = null;
  let session: SecureSession | null = null;
  let stage: HandshakeStage = 'idle';

  function setStage(next: HandshakeStage) {
    stage = next;
    opts.emit({ type: 'stage', stage });
  }

  function fail(message: string, code?: string) {
    stage = 'failed';
    opts.emit({ type: 'error', message, code });
  }

  function start() {
    if (stage !== 'idle') return;

    const ephemeral = generateX25519KeyPair();
    const clientNonce = random32();

    pending = {
      pairing: opts.pairing,
      identity: opts.identity,
      ephemeralPriv: ephemeral.privateKey,
      ephemeralPubBase64: ephemeral.publicKeyBase64,
      clientNonce,
      handshakeMode,
    };

    const hello: ClientHello = {
      kind: 'clientHello',
      protocolVersion: SECURE_PROTOCOL_VERSION,
      sessionId: opts.pairing.sessionId,
      handshakeMode,
      phoneDeviceId: opts.identity.phoneDeviceId,
      phoneIdentityPublicKey: opts.identity.phoneIdentityPublicKey,
      phoneEphemeralPublicKey: ephemeral.publicKeyBase64,
      clientNonce: bytesToBase64(clientNonce),
      iosAppVersion: IOS_APP_VERSION_TO_CLAIM,
    };

    setStage('sending-client-hello');
    opts.sendWire(JSON.stringify(hello));
    setStage('awaiting-server-hello');
  }

  function handleServerHello(msg: ServerHello) {
    if (!pending) {
      fail('Got serverHello before clientHello was sent', 'unexpected_server_hello');
      return;
    }

    if (msg.protocolVersion !== SECURE_PROTOCOL_VERSION) {
      fail(`Bridge protocol version ${msg.protocolVersion} != phone ${SECURE_PROTOCOL_VERSION}`, 'incompatible_version');
      return;
    }
    if (msg.sessionId !== pending.pairing.sessionId) {
      fail('serverHello sessionId mismatch', 'invalid_session');
      return;
    }
    if (msg.macDeviceId !== pending.pairing.macDeviceId) {
      fail('serverHello macDeviceId does not match the QR', 'mac_device_mismatch');
      return;
    }
    if (msg.macIdentityPublicKey !== pending.pairing.macIdentityPublicKey) {
      fail('serverHello macIdentityPublicKey does not match the QR', 'mac_identity_mismatch');
      return;
    }
    if (msg.clientNonce !== bytesToBase64(pending.clientNonce)) {
      fail('serverHello did not echo our clientNonce', 'invalid_nonce_echo');
      return;
    }

    // Build the transcript exactly as the bridge did and verify the Mac's signature over it.
    const transcript = buildTranscriptBytes({
      sessionId: pending.pairing.sessionId,
      protocolVersion: msg.protocolVersion,
      handshakeMode: msg.handshakeMode,
      keyEpoch: msg.keyEpoch,
      macDeviceId: msg.macDeviceId,
      phoneDeviceId: pending.identity.phoneDeviceId,
      macIdentityPublicKeyBase64: msg.macIdentityPublicKey,
      phoneIdentityPublicKeyBase64: pending.identity.phoneIdentityPublicKey,
      macEphemeralPublicKeyBase64: msg.macEphemeralPublicKey,
      phoneEphemeralPublicKeyBase64: pending.ephemeralPubBase64,
      clientNonce: pending.clientNonce,
      serverNonce: base64ToU8(msg.serverNonce),
      expiresAtForTranscript: msg.expiresAtForTranscript,
    });

    const signatureValid = ed25519Verify(msg.macIdentityPublicKey, transcript, msg.macSignature);
    if (!signatureValid) {
      fail('Mac identity signature did not verify — refusing handshake', 'invalid_mac_signature');
      return;
    }

    // Sign the client-auth transcript with our identity key.
    const phoneSignature = ed25519Sign(
      pending.identity.phoneIdentityPrivateKey,
      clientAuthTranscript(transcript),
    );

    const auth: ClientAuth = {
      kind: 'clientAuth',
      sessionId: pending.pairing.sessionId,
      phoneDeviceId: pending.identity.phoneDeviceId,
      keyEpoch: msg.keyEpoch,
      phoneSignature,
    };

    setStage('sending-client-auth');
    opts.sendWire(JSON.stringify(auth));
    setStage('awaiting-secure-ready');

    // Pre-derive AES keys now that we have the shared secret + transcript salt.
    const sharedSecret = x25519SharedSecret(pending.ephemeralPriv, msg.macEphemeralPublicKey);
    const salt = sha256Bytes(transcript);
    const infoPrefix =
      `${HANDSHAKE_TAG}|${pending.pairing.sessionId}|${msg.macDeviceId}|${pending.identity.phoneDeviceId}|${msg.keyEpoch}`;

    session = {
      sessionId: pending.pairing.sessionId,
      keyEpoch: msg.keyEpoch,
      macDeviceId: msg.macDeviceId,
      macIdentityPublicKey: msg.macIdentityPublicKey,
      phoneToMacKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|phoneToMac`),
      macToPhoneKey: deriveAesKey(sharedSecret, salt, `${infoPrefix}|macToPhone`),
      lastInboundCounter: -1,
      nextOutboundCounter: 0,
    };
  }

  function handleSecureReady(msg: SecureReady) {
    if (!session) {
      fail('secureReady arrived before we derived keys', 'unexpected_secure_ready');
      return;
    }
    if (msg.sessionId !== session.sessionId || msg.keyEpoch !== session.keyEpoch) {
      fail('secureReady identity mismatch', 'invalid_secure_ready');
      return;
    }

    pending = null;
    setStage('paired');
    opts.emit({ type: 'paired', session });

    // Send a fresh-pair resumeState so the bridge knows we have nothing buffered yet.
    const resume: ResumeState = {
      kind: 'resumeState',
      sessionId: session.sessionId,
      keyEpoch: session.keyEpoch,
      lastAppliedBridgeOutboundSeq: 0,
    };
    opts.sendWire(JSON.stringify(resume));
  }

  function handleSecureError(msg: SecureError) {
    fail(`Bridge: ${msg.message}`, msg.code);
  }

  function handleWireText(text: string) {
    let parsed: { kind?: string };
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }

    switch (parsed.kind) {
      case 'serverHello':
        handleServerHello(parsed as ServerHello);
        return;
      case 'secureReady':
        handleSecureReady(parsed as SecureReady);
        return;
      case 'secureError':
        handleSecureError(parsed as SecureError);
        return;
      case 'encryptedEnvelope':
        // Application-level envelopes are exposed to the caller via decryptApplication.
        // Caller is expected to call decryptApplication after observing this kind.
        return;
      default:
        return;
    }
  }

  function encryptApplication(payloadText: string): string {
    if (!session) throw new Error('encrypt requested before secure channel ready');
    const counter = session.nextOutboundCounter;
    session.nextOutboundCounter += 1;

    const innerJson = JSON.stringify({ payloadText });
    const { ciphertextBase64, tagBase64 } = encryptGCM(
      { key: session.phoneToMacKey, sender: SENDER_IPHONE, counter },
      utf8Bytes(innerJson),
    );

    const env: EncryptedEnvelope = {
      kind: 'encryptedEnvelope',
      v: SECURE_PROTOCOL_VERSION,
      sessionId: session.sessionId,
      keyEpoch: session.keyEpoch,
      sender: SENDER_IPHONE,
      counter,
      ciphertext: ciphertextBase64,
      tag: tagBase64,
    };
    return JSON.stringify(env);
  }

  function decryptApplication(envelope: EncryptedEnvelope): string | null {
    if (!session) return null;
    if (envelope.sessionId !== session.sessionId) return null;
    if (envelope.keyEpoch !== session.keyEpoch) return null;
    if (envelope.sender !== SENDER_MAC) return null;
    if (!Number.isInteger(envelope.counter) || envelope.counter <= session.lastInboundCounter) return null;

    const plaintext = decryptGCM(
      { key: session.macToPhoneKey, sender: SENDER_MAC, counter: envelope.counter },
      envelope.ciphertext,
      envelope.tag,
    );
    if (!plaintext) return null;

    session.lastInboundCounter = envelope.counter;

    try {
      const inner = JSON.parse(new TextDecoder().decode(plaintext)) as {
        bridgeOutboundSeq?: number;
        payloadText?: string;
      };
      return typeof inner.payloadText === 'string' ? inner.payloadText : null;
    } catch {
      return null;
    }
  }

  function isPaired(): boolean {
    return stage === 'paired';
  }

  return { start, handleWireText, encryptApplication, decryptApplication, isPaired };
}

function base64ToU8(b64: string): Uint8Array {
  // tiny inline import to keep this module self-contained
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { base64ToBytes } = require('./base64') as typeof import('./base64');
  return base64ToBytes(b64);
}
