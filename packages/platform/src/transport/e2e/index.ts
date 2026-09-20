export {
  generateDeviceKeyPair,
  signMessage,
  verifySignature,
  type DeviceEncryptionKey,
  type DeviceSigningKey,
  type DeviceKeyPair,
} from "./device-key.js";

export {
  generateDek,
  sealMessage,
  openMessage,
  wrapDekForDevice,
  unwrapDek,
  DEK_LENGTH,
  type SealedEnvelope,
} from "./envelope.js";

export { MessageRatchet } from "./ratchet.js";

export { SessionCrypto, e2eRoundTrip } from "./session-crypto.js";

export { generateRecoveryCode, hashRecoveryCode, verifyRecoveryCode } from "./recovery.js";
