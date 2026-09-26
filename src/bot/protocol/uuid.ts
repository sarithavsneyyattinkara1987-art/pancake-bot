/**
 * Offline-mode UUIDs.
 *
 * A vanilla client in offline mode derives the profile UUID as the version-3
 * UUID of "OfflinePlayer:<name>" (MD5). Implementing it here (instead of a
 * random UUID) keeps the bot indistinguishable from a real client for
 * plugins that key data on the canonical offline UUID.
 *
 * The test suite checks the MD5 core against node:crypto.
 */

const S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/** K[i] = floor(abs(sin(i + 1)) * 2^32) */
const K = new Int32Array(64);
for (let i = 0; i < 64; i++) {
  K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;
}

function rotl(value: number, bits: number): number {
  return (value << bits) | (value >>> (32 - bits));
}

export function md5(input: Uint8Array): Uint8Array {
  const bitLength = input.byteLength * 8;
  const paddedLength = (((input.byteLength + 8) >> 6) + 1) * 64;
  const buffer = new Uint8Array(paddedLength);
  buffer.set(input);
  buffer[input.byteLength] = 0x80;
  // Little-endian 64-bit length in the final 8 bytes.
  const view = new DataView(buffer.buffer);
  view.setUint32(paddedLength - 8, bitLength >>> 0, true);
  view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;

  const m = new Int32Array(16);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getInt32(offset + i * 4, true);

    let aa = a;
    let bb = b;
    let cc = c;
    let dd = d;

    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      if (i < 16) {
        f = (bb & cc) | (~bb & dd);
        g = i;
      } else if (i < 32) {
        f = (dd & bb) | (~dd & cc);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = bb ^ cc ^ dd;
        g = (3 * i + 5) % 16;
      } else {
        f = cc ^ (bb | ~dd);
        g = (7 * i) % 16;
      }
      const tmp = dd;
      dd = cc;
      cc = bb;
      bb = (bb + rotl((aa + f + K[i] + m[g]) | 0, S[i])) | 0;
      aa = tmp;
    }

    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }

  const out = new Uint8Array(16);
  const outView = new DataView(out.buffer);
  outView.setInt32(0, a, true);
  outView.setInt32(4, b, true);
  outView.setInt32(8, c, true);
  outView.setInt32(12, d, true);
  return out;
}

/** Canonical dashed UUID from 16 bytes, with version/variant applied. */
function formatUuid(bytes: Uint8Array, version: number, variantHighBits: number): string {
  const copy = Uint8Array.from(bytes);
  copy[6] = (copy[6] & 0x0f) | (version << 4);
  copy[8] = (copy[8] & 0x3f) | variantHighBits;
  let hex = "";
  for (let i = 0; i < 16; i++) hex += copy[i].toString(16).padStart(2, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Offline profile UUID: md5("OfflinePlayer:" + name), version 3, RFC variant. */
export function offlineUuid(username: string): string {
  const bytes = new TextEncoder().encode(`OfflinePlayer:${username}`);
  return formatUuid(md5(bytes), 3, 0x80);
}
