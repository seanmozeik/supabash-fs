import type { AnyDelegatedCapabilityClaims } from '../api/capability.js';
import { asUnknownRecord } from '../api/json.js';

const text = new TextEncoder();
const json = new TextDecoder();

export type CapabilityAlgorithm = 'EdDSA' | 'HS256';

export const compactJws = async (
  algorithm: CapabilityAlgorithm,
  header: Readonly<Record<string, string>>,
  payload: AnyDelegatedCapabilityClaims,
  key: CryptoKey,
): Promise<string> => {
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = await crypto.subtle.sign(
    signatureParameters(algorithm),
    key,
    text.encode(signingInput),
  );
  return `${signingInput}.${bytesToB64url(new Uint8Array(signature))}`;
};

export const verifyCompactJws = async (
  algorithm: CapabilityAlgorithm,
  capability: string,
  key: CryptoKey,
): Promise<{ header: Record<string, unknown>; payload: unknown }> => {
  const [headerPart, payloadPart, signaturePart] = splitCompact(capability);
  const signingInput = `${headerPart}.${payloadPart}`;
  const valid = await crypto.subtle.verify(
    signatureParameters(algorithm),
    key,
    copyBytes(b64urlToBytes(signaturePart)),
    text.encode(signingInput),
  );
  if (!valid) {
    throw new Error('JWS signature is invalid.');
  }
  return { header: parseJsonObject(b64urlToJson(headerPart)), payload: b64urlToJson(payloadPart) };
};

export const jwsKeyId = (
  header: Record<string, unknown>,
  algorithm: CapabilityAlgorithm,
): string => {
  const keyId = header['kid'];
  if (header['alg'] !== algorithm || typeof keyId !== 'string' || keyId.length === 0) {
    throw new Error(`Capability header is not a keyed ${algorithm} header.`);
  }
  return keyId;
};

export const peekCompactJwsHeader = (capability: string): Record<string, unknown> => {
  const [headerPart] = splitCompact(capability);
  return parseJsonObject(b64urlToJson(headerPart));
};

export const peekCompactJwsPayload = (capability: string): Record<string, unknown> => {
  const [, payloadPart] = splitCompact(capability);
  return parseJsonObject(b64urlToJson(payloadPart));
};

const signatureParameters = (
  algorithm: CapabilityAlgorithm,
): AlgorithmIdentifier | HmacKeyAlgorithm =>
  algorithm === 'EdDSA' ? { name: 'Ed25519' } : { name: 'HMAC', hash: { name: 'SHA-256' } };

const splitCompact = (capability: string): readonly [string, string, string] => {
  const parts = capability.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error('Capability is not a compact JWS.');
  }
  return [parts[0] ?? '', parts[1] ?? '', parts[2] ?? ''];
};

const b64urlJson = (value: unknown): string => bytesToB64url(text.encode(JSON.stringify(value)));

const b64urlToJson = (value: string): unknown => JSON.parse(json.decode(b64urlToBytes(value)));

const parseJsonObject = (value: unknown): Record<string, unknown> => {
  const record = asUnknownRecord(value);
  if (record === undefined) {
    throw new Error('JWS header is not an object.');
  }
  return record;
};

const bytesToB64url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

const b64urlToBytes = (value: string): Uint8Array => {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/');
  const base64 = padded.padEnd(Math.ceil(padded.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.codePointAt(index) ?? 0;
  }
  return bytes;
};

const copyBytes = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy;
};
