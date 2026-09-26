/**
 * Pure-TS crypto needed by the Minecraft login sequence:
 *
 *  - AES-128 in CFB8 mode (the online-mode encryption channel; CFB8 is not
 *    available in WebCrypto, and a byte-at-a-time cipher keeps streaming
 *    decryption trivial)
 *  - RSAES-PKCS1-v1_5 encryption with the server's public key
 *    (encrypting the shared secret from the Encryption Request)
 *  - SHA-1 / SHA-256 helpers via WebCrypto (serverId hash + resource-pack
 *    hash verification)
 *
 * The suite verifies all of this against node:crypto, so the same code is
 * trusted in the browser, in the Termux CLI and in tests.
 */

const SBOX = buildSbox();
const RCON = new Uint8Array([0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80, 0x1b, 0x36]);

function rotl8(v: number, n: number): number {
  return ((v << n) | (v >>> (8 - n))) & 0xff;
}

function buildSbox(): Uint8Array {
  const sbox = new Uint8Array(256);
  let p = 1;
  let q = 1;
  do {
    p = (p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0)) & 0xff;
    q ^= (q << 1) & 0xff;
    q ^= (q << 2) & 0xff;
    q ^= (q << 4) & 0xff;
    if (q & 0x80) q ^= 0x09;
    q &= 0xff;
    const xformed = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4);
    sbox[p] = xformed ^ 0x63;
  } while (p !== 1);
  sbox[0] = 0x63;
  return sbox;
}

function xtime(v: number): number {
  return ((v << 1) ^ (v & 0x80 ? 0x1b : 0)) & 0xff;
}

function expandKey128(key: Uint8Array): Uint8Array {
  if (key.byteLength !== 16) throw new Error("AES-128 requires a 16 byte key");
  const w = new Uint8Array(176);
  w.set(key, 0);
  let generated = 16;
  let rconIndex = 0;
  const temp = new Uint8Array(4);
  while (generated < 176) {
    temp.set(w.subarray(generated - 4, generated));
    if (generated % 16 === 0) {
      const t = temp[0];
      temp[0] = SBOX[temp[1]] ^ RCON[rconIndex++];
      temp[1] = SBOX[temp[2]];
      temp[2] = SBOX[temp[3]];
      temp[3] = SBOX[t];
    }
    for (let i = 0; i < 4; i++) {
      w[generated] = w[generated - 16] ^ temp[i];
      generated++;
    }
  }
  return w;
}

/** Encrypt one 16-byte block with the AES-128 ECB primitive. */
export function aes128EncryptBlock(roundKeys: Uint8Array, block: Uint8Array): Uint8Array {
  const state = Uint8Array.from(block);
  addRoundKey(state, roundKeys, 0);
  for (let round = 1; round < 10; round++) {
    subBytes(state);
    shiftRows(state);
    mixColumns(state);
    addRoundKey(state, roundKeys, round);
  }
  subBytes(state);
  shiftRows(state);
  addRoundKey(state, roundKeys, 10);
  return state;
}

function addRoundKey(state: Uint8Array, w: Uint8Array, round: number): void {
  const off = round * 16;
  for (let i = 0; i < 16; i++) state[i] ^= w[off + i];
}

function subBytes(state: Uint8Array): void {
  for (let i = 0; i < 16; i++) state[i] = SBOX[state[i]];
}

function shiftRows(state: Uint8Array): void {
  // Column-major state: index = col * 4 + row.
  const tmp = new Uint8Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      tmp[col * 4 + row] = state[((col + row) % 4) * 4 + row];
    }
  }
  state.set(tmp);
}

function mixColumns(state: Uint8Array): void {
  for (let col = 0; col < 4; col++) {
    const base = col * 4;
    const a0 = state[base];
    const a1 = state[base + 1];
    const a2 = state[base + 2];
    const a3 = state[base + 3];
    state[base] = xtime(a0) ^ (xtime(a1) ^ a1) ^ a2 ^ a3;
    state[base + 1] = a0 ^ xtime(a1) ^ (xtime(a2) ^ a2) ^ a3;
    state[base + 2] = a0 ^ a1 ^ xtime(a2) ^ (xtime(a3) ^ a3);
    state[base + 3] = (xtime(a0) ^ a0) ^ a1 ^ a2 ^ xtime(a3);
  }
}

/**
 * Stateful AES-128 CFB8 cipher. CFB uses the same function for both
 * directions, so one class drives encryption and decryption of the channel.
 */
export class AesCfb8 {
  private readonly roundKeys: Uint8Array;
  private readonly register: Uint8Array;

  constructor(key: Uint8Array, iv: Uint8Array) {
    if (iv.byteLength !== 16) throw new Error("CFB8 IV must be 16 bytes");
    this.roundKeys = expandKey128(key);
    this.register = Uint8Array.from(iv);
  }

  process(data: Uint8Array): Uint8Array {
    const out = new Uint8Array(data.byteLength);
    for (let i = 0; i < data.byteLength; i++) {
      const keystream = aes128EncryptBlock(this.roundKeys, this.register)[0];
      const cipherByte = data[i] ^ keystream;
      out[i] = cipherByte;
      this.register.copyWithin(0, 1);
      this.register[15] = cipherByte;
    }
    return out;
  }
}

/** Encrypt the shared secret with the server's RSA public key (PKCS#1 v1.5). */
export function rsaPkcs1v15Encrypt(spkiDer: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const { n, e } = parseRsaPublicKey(spkiDer);
  const k = (bitLength(n) + 7) >> 3;
  if (plaintext.byteLength + 11 > k) {
    throw new Error("RSA plaintext too long for modulus");
  }
  // EM = 0x00 || 0x02 || PS (non-zero random) || 0x00 || M
  const em = new Uint8Array(k);
  em[1] = 0x02;
  const ps = em.subarray(2, k - plaintext.byteLength - 1);
  getRandomBytes(ps);
  for (let i = 0; i < ps.byteLength; i++) {
    if (ps[i] === 0) ps[i] = 0x01;
  }
  em[k - plaintext.byteLength - 1] = 0x00;
  em.set(plaintext, k - plaintext.byteLength);

  const c = modPow(bytesToBigInt(em), e, n);
  return bigIntToBytes(c, k);
}

export interface RsaPublicKey {
  n: bigint;
  e: bigint;
}

interface Cursor {
  i: number;
}

function expectTag(bytes: Uint8Array, c: Cursor, tag: number): number {
  if (bytes[c.i] !== tag) {
    throw new Error(
      `Malformed DER: expected tag 0x${tag.toString(16)}, got 0x${(bytes[c.i] ?? -1).toString(16)} at ${c.i}`,
    );
  }
  c.i++;
  return readDerLen(bytes, c);
}

function readDerLen(bytes: Uint8Array, c: Cursor): number {
  const first = bytes[c.i++];
  if (first === undefined) throw new Error("Malformed DER: truncated length");
  if (first < 0x80) return first;
  const count = first & 0x7f;
  if (count > 4) throw new Error("Malformed DER: length too large");
  let len = 0;
  for (let i = 0; i < count; i++) len = (len << 8) | (bytes[c.i++] ?? 0);
  return len;
}

/** Parse SubjectPublicKeyInfo wrapping an RSAPublicKey. */
export function parseRsaPublicKey(der: Uint8Array): RsaPublicKey {
  const c: Cursor = { i: 0 };
  expectTag(der, c, 0x30); // SPKI SEQUENCE
  expectTag(der, c, 0x30); // AlgorithmIdentifier SEQUENCE
  const algLen = readDerLen(der, c);
  c.i += algLen; // skip OID + NULL (rsaEncryption)
  const bitLen = expectTag(der, c, 0x03); // BIT STRING
  const unused = der[c.i++];
  if (unused !== 0x00) throw new Error("Malformed SPKI: non-zero unused bits");
  const key = der.subarray(c.i, c.i + bitLen - 1);

  const k: Cursor = { i: 0 };
  expectTag(key, k, 0x30); // RSAPublicKey SEQUENCE
  readDerLen(key, k);
  const nLen = expectTag(key, k, 0x02);
  const n = bytesToBigInt(key.subarray(k.i, k.i + nLen));
  k.i += nLen;
  const eLen = expectTag(key, k, 0x02);
  const e = bytesToBigInt(key.subarray(k.i, k.i + eLen));
  if (n <= 0n || e <= 0n) throw new Error("Malformed RSAPublicKey: non-positive values");
  return { n, e };
}

function bitLength(v: bigint): number {
  return v.toString(2).length;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let out = 0n;
  for (const b of bytes) out = (out << 8n) | BigInt(b);
  return out;
}

function bigIntToBytes(v: bigint, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let x = v;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

function getRandomBytes(out: Uint8Array): void {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== "function") {
    throw new Error("No CSPRNG available (crypto.getRandomValues missing)");
  }
  cryptoObj.getRandomValues(out);
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  getRandomBytes(out);
  return out;
}

async function digest(algorithm: "SHA-1" | "SHA-256", data: Uint8Array): Promise<Uint8Array> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("WebCrypto subtle API unavailable in this runtime");
  const buf = await subtle.digest(algorithm, data as unknown as BufferSource);
  return new Uint8Array(buf);
}

export const sha1 = (data: Uint8Array) => digest("SHA-1", data);
export const sha256 = (data: Uint8Array) => digest("SHA-256", data);

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  const out = new Uint8Array(clean.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Minecraft serverId hash used by the Encryption Response: a digest with the
 * high bit set is prefixed with 0x00 so the server sees a non-negative value.
 */
export async function computeServerHash(
  serverId: string,
  sharedSecret: Uint8Array,
  publicKeySpki: Uint8Array,
): Promise<string> {
  const encodedId = new TextEncoder().encode(serverId);
  const joined = new Uint8Array(encodedId.byteLength + sharedSecret.byteLength + publicKeySpki.byteLength);
  let off = 0;
  joined.set(encodedId, off);
  off += encodedId.byteLength;
  joined.set(sharedSecret, off);
  off += sharedSecret.byteLength;
  joined.set(publicKeySpki, off);
  const hash = await sha1(joined);
  if (hash[0] & 0x80) {
    const prefixed = new Uint8Array(21);
    prefixed.set(hash, 1);
    return toHex(await sha1(prefixed));
  }
  return toHex(hash);
}
