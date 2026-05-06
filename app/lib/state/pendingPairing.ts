// Module-scoped singleton used to hand the parsed pairing payload from the
// scanner screen to the pairing screen without serializing through router params.
// Pair flow consumes it on mount; if missing, the screen bounces back to /scan.

import { PairingPayload } from '../protocol/qr';

let _pending: PairingPayload | null = null;

export const pendingPairing = {
  set(payload: PairingPayload | null): void {
    _pending = payload;
  },
  consume(): PairingPayload | null {
    const out = _pending;
    _pending = null;
    return out;
  },
  peek(): PairingPayload | null {
    return _pending;
  },
};
