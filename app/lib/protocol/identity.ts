// Phone-side identity persistence. One Ed25519 keypair per install, plus a
// stable phoneDeviceId UUID. Both stored in expo-secure-store (Android Keystore /
// iOS Keychain). Generated lazily on first call.

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { Ed25519KeyPair, generateEd25519KeyPair } from './crypto';

const KEY_PRIVATE = 'remodex.identity.privateKey';
const KEY_PUBLIC = 'remodex.identity.publicKey';
const KEY_DEVICE_ID = 'remodex.identity.deviceId';

export type PhoneIdentity = {
  phoneDeviceId: string;
  phoneIdentityPublicKey: string;
  phoneIdentityPrivateKey: string;
};

export async function loadOrCreatePhoneIdentity(): Promise<PhoneIdentity> {
  const [priv, pub, deviceId] = await Promise.all([
    SecureStore.getItemAsync(KEY_PRIVATE),
    SecureStore.getItemAsync(KEY_PUBLIC),
    SecureStore.getItemAsync(KEY_DEVICE_ID),
  ]);

  if (priv && pub && deviceId) {
    return {
      phoneDeviceId: deviceId,
      phoneIdentityPublicKey: pub,
      phoneIdentityPrivateKey: priv,
    };
  }

  const fresh = generateEd25519KeyPair();
  const newDeviceId = Crypto.randomUUID();

  await Promise.all([
    SecureStore.setItemAsync(KEY_PRIVATE, fresh.privateKeyBase64),
    SecureStore.setItemAsync(KEY_PUBLIC, fresh.publicKeyBase64),
    SecureStore.setItemAsync(KEY_DEVICE_ID, newDeviceId),
  ]);

  return {
    phoneDeviceId: newDeviceId,
    phoneIdentityPublicKey: fresh.publicKeyBase64,
    phoneIdentityPrivateKey: fresh.privateKeyBase64,
  };
}

export async function wipePhoneIdentity(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEY_PRIVATE),
    SecureStore.deleteItemAsync(KEY_PUBLIC),
    SecureStore.deleteItemAsync(KEY_DEVICE_ID),
  ]);
}
