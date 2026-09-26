import { describe, expect, test } from "bun:test";
import {
  constants,
  createHash,
  createCipheriv,
  createDecipheriv,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
} from "node:crypto";
import {
  AesCfb8,
  aes128EncryptBlock,
  computeServerHash,
  fromHex,
  parseRsaPublicKey,
  randomBytes,
  rsaPkcs1v15Encrypt,
  sha1,
  sha256,
  toHex,
} from "../src/bot/protocol/crypto";

/** Standard AES-128 key schedule (FIPS-197), used only by the tests. */
function expandKey128(key: Uint8Array): Uint8Array {
  const sbox = AES_SBOX;
  const w = new Uint8Array(176);
  w.set(key, 0);
  let generated = 16;
  let rcon = 1;
  const temp = new Uint8Array(4);
  while (generated < 176) {
    temp.set(w.subarray(generated - 4, generated));
    if (generated % 16 === 0) {
      const t = temp[0];
      temp[0] = sbox[temp[1]] ^ rcon;
      temp[1] = sbox[temp[2]];
      temp[2] = sbox[temp[3]];
      temp[3] = sbox[t];
      rcon = ((rcon << 1) ^ (rcon & 0x80 ? 0x11b : 0)) & 0xff;
    }
    for (let i = 0; i < 4; i++) {
      w[generated] = w[generated - 16] ^ temp[i];
      generated++;
    }
  }
  return w;
}

// FIPS-197 Appendix S.1 first column entries needed for the schedule test are
// covered by the full table below (generated from the canonical byte list).
const AES_SBOX = new Uint8Array([
  0x63, 0x7c, 0x77, 0x7b, 0xf2, 0x6b, 0x6f, 0xc5, 0x30, 0x01, 0x67, 0x2b, 0xfe, 0xd7, 0xab, 0x76,
  0xca, 0x82, 0xc9, 0x7d, 0xfa, 0x59, 0x47, 0xf0, 0xad, 0xd4, 0xa2, 0xaf, 0x9c, 0xa4, 0x72, 0xc0,
  0xb7, 0xfd, 0x93, 0x26, 0x36, 0x3f, 0xf7, 0xcc, 0x34, 0xa5, 0xe5, 0xf1, 0x71, 0xd8, 0x31, 0x15,
  0x04, 0xc7, 0x23, 0xc3, 0x18, 0x96, 0x05, 0x9a, 0x07, 0x12, 0x80, 0xe2, 0xeb, 0x27, 0xb2, 0x75,
  0x09, 0x83, 0x2c, 0x1a, 0x1b, 0x6e, 0x5a, 0xa0, 0x52, 0x3b, 0xd6, 0xb3, 0x29, 0xe3, 0x2f, 0x84,
  0x53, 0xd1, 0x00, 0xed, 0x20, 0xfc, 0xb1, 0x5b, 0x6a, 0xcb, 0xbe, 0x39, 0x4a, 0x4c, 0x58, 0xcf,
  0xd0, 0xef, 0xaa, 0xfb, 0x43, 0x4d, 0x33, 0x85, 0x45, 0xf9, 0x02, 0x7f, 0x50, 0x3c, 0x9f, 0xa8,
  0x51, 0xa3, 0x40, 0x8f, 0x92, 0x9d, 0x38, 0xf5, 0xbc, 0xb6, 0xda, 0x21, 0x10, 0xff, 0xf3, 0xd2,
  0xcd, 0x0c, 0x13, 0xec, 0x5f, 0x97, 0x44, 0x17, 0xc4, 0xa7, 0x7e, 0x3d, 0x64, 0x5d, 0x19, 0x73,
  0x60, 0x81, 0x4f, 0xdc, 0x22, 0x2a, 0x90, 0x88, 0x46, 0xee, 0xb8, 0x14, 0xde, 0x5e, 0x0b, 0xdb,
  0xe0, 0x32, 0x3a, 0x0a, 0x49, 0x06, 0x24, 0x5c, 0xc2, 0xd3, 0xac, 0x62, 0x91, 0x95, 0xe4, 0x79,
  0xe7, 0xc8, 0x37, 0x6d, 0x8d, 0xd5, 0x4e, 0xa9, 0x6c, 0x56, 0xf4, 0xea, 0x65, 0x7a, 0xae, 0x08,
  0xba, 0x78, 0x25, 0x2e, 0x1c, 0xa6, 0xb4, 0xc6, 0xe8, 0xdd, 0x74, 0x1f, 0x4b, 0xbd, 0x8b, 0x8a,
  0x70, 0x3e, 0xb5, 0x66, 0x48, 0x03, 0xf6, 0x0e, 0x61, 0x35, 0x57, 0xb9, 0x86, 0xc1, 0x1d, 0x9e,
  0xe1, 0xf8, 0x98, 0x11, 0x69, 0xd9, 0x8e, 0x94, 0x9b, 0x1e, 0x87, 0xe9, 0xce, 0x55, 0x28, 0xdf,
  0x8c, 0xa1, 0x89, 0x0d, 0xbf, 0xe6, 0x42, 0x68, 0x41, 0x99, 0x2d, 0x0f, 0xb0, 0x54, 0xbb, 0x16,
]);

describe("AES-128 primitives", () => {
  test("aes128EncryptBlock matches the NIST FIPS-197 vector", () => {
    const key = fromHex("000102030405060708090a0b0c0d0e0f");
    const plaintext = fromHex("00112233445566778899aabbccddeeff");
    const expected = fromHex("69c4e0d86a7b0430d8cdb78070b4c55a");
    const roundKeys = expandKey128(key);
    expect(Array.from(aes128EncryptBlock(roundKeys, plaintext))).toEqual(Array.from(expected));
  });

  /**
   * Reference CFB8 built on node's AES-ECB primitive: keystream byte =
   * AES(register)[0], register shifts in the ciphertext byte. This validates
   * both our AES block cipher/schedule and the streaming logic.
   */
  function nodeCfb8(data: Uint8Array, key: Uint8Array, iv: Uint8Array, encrypt: boolean): Uint8Array {
    const out = new Uint8Array(data.byteLength);
    const reg = Buffer.from(iv);
    const cipher = createCipheriv("aes-128-ecb", Buffer.from(key), null);
    cipher.setAutoPadding(false);
    // ECB has no chaining; a 16-byte update returns the block immediately.
    for (let i = 0; i < data.byteLength; i++) {
      const keystream = cipher.update(reg)[0];
      const input = data[i];
      const output = input ^ keystream;
      out[i] = output;
      reg.copyWithin(0, 1);
      reg[15] = encrypt ? output : input;
    }
    return out;
  }

  test("AesCfb8 decrypts what a node-ECB CFB8 reference encrypts", () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const plaintext = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
    const nodeEncrypted = nodeCfb8(plaintext, key, iv, true);

    const client = new AesCfb8(key, iv, "decrypt");
    const decrypted = client.process(nodeEncrypted);
    expect(Buffer.from(decrypted).toString("utf8")).toBe(Buffer.from(plaintext).toString("utf8"));
  });

  test("AesCfb8 output decrypts with the node-ECB CFB8 reference", () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const plaintext = new TextEncoder().encode("encryption response payload");

    const clientEnc = new AesCfb8(key, iv, "encrypt");
    const encrypted = clientEnc.process(plaintext);

    const decrypted = nodeCfb8(encrypted, key, iv, false);
    expect(Buffer.from(decrypted).toString("utf8")).toBe("encryption response payload");
  });

  test("encrypt -> decrypt channel roundtrip through two instances", () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const plaintext = randomBytes(64);
    const sender = new AesCfb8(key, iv, "encrypt");
    const receiver = new AesCfb8(key, iv, "decrypt");
    const wire = sender.process(plaintext);
    // byte-wise chunking must not matter (streaming TCP)
    const received = new Uint8Array(wire.byteLength);
    let offset = 0;
    while (offset < wire.byteLength) {
      const chunk = wire.subarray(offset, offset + 7);
      received.set(receiver.process(chunk), offset);
      offset += 7;
    }
    expect(Array.from(received)).toEqual(Array.from(plaintext));
  });

  test("streaming byte-by-byte equals one-shot processing", () => {
    const key = randomBytes(16);
    const iv = randomBytes(16);
    const data = randomBytes(97);
    const oneShot = new AesCfb8(key, iv, "encrypt").process(data);
    const streaming = new AesCfb8(key, iv, "encrypt");
    const out = new Uint8Array(data.byteLength);
    for (let i = 0; i < data.byteLength; i++) {
      out.set(streaming.process(data.subarray(i, i + 1)), i);
    }
    expect(Array.from(out)).toEqual(Array.from(oneShot));
  });
});

describe("RSA (PKCS#1 v1.5)", () => {
  test("encrypts for a node-generated keypair that node can decrypt", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 1024,
      publicExponent: 65537,
    });
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const secret = randomBytes(16); // Minecraft shared secret: 16 bytes

    const ciphertext = rsaPkcs1v15Encrypt(new Uint8Array(spki), secret);
    expect(ciphertext.byteLength).toBe(128);

    // Bun/Node block RSA_PKCS1_PADDING private decryption (CVE hardening), so
    // recover the raw encoded message with an unpadded private operation and
    // verify the PKCS#1 v1.5 structure by hand — an independent check of the
    // padding construction (the server does exactly this unpad step).
    const em = privateDecrypt(
      { key: privateKey, padding: constants.RSA_NO_PADDING },
      Buffer.from(ciphertext),
    );
    expect(em.byteLength).toBe(128);
    expect(em[0]).toBe(0x00);
    expect(em[1]).toBe(0x02); // block type 2 (encryption)
    const separator = 128 - secret.byteLength - 1;
    expect(em[separator]).toBe(0x00);
    // PS: non-zero bytes between 0x02 and the separator, at least 8 long
    expect(separator - 2).toBeGreaterThanOrEqual(8);
    for (let i = 2; i < separator; i++) expect(em[i]).not.toBe(0x00);
    expect(Buffer.from(em.subarray(separator + 1))).toEqual(Buffer.from(secret));
  });

  test("ciphertext is exactly c = EM^e mod n (node public operation)", () => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const secret = randomBytes(16);
    const ciphertext = rsaPkcs1v15Encrypt(new Uint8Array(spki), secret);
    const em = privateDecrypt(
      { key: privateKey, padding: constants.RSA_NO_PADDING },
      Buffer.from(ciphertext),
    );
    const reencrypted = publicEncrypt(
      { key: publicKey, padding: constants.RSA_NO_PADDING },
      em,
    );
    expect(Buffer.from(reencrypted)).toEqual(Buffer.from(ciphertext));
  });

  test("rejects plaintexts larger than the modulus allows", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 512 });
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    expect(() => rsaPkcs1v15Encrypt(new Uint8Array(spki), new Uint8Array(64))).toThrow();
  });

  test("parseRsaPublicKey extracts n and e", () => {
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const parsed = parseRsaPublicKey(new Uint8Array(spki));
    expect(parsed.e).toBe(65537n);
    expect(parsed.n.toString(16).length).toBeGreaterThan(250);
  });
});

describe("hashes", () => {
  test("sha1 matches node:crypto", async () => {
    const data = new TextEncoder().encode("pancakesmp");
    expect(toHex(await sha1(data))).toBe(createHash("sha1").update(Buffer.from(data)).digest("hex"));
  });

  test("sha256 matches node:crypto", async () => {
    const data = randomBytes(333);
    expect(toHex(await sha256(data))).toBe(
      createHash("sha256").update(Buffer.from(data)).digest("hex"),
    );
  });

  test("hex helpers roundtrip", () => {
    const bytes = randomBytes(20);
    expect(Array.from(fromHex(toHex(bytes)))).toEqual(Array.from(bytes));
  });

  test("computeServerHash matches signed BigInteger hex semantics", async () => {
    const serverId = "pancakesmp.kinetic.host";
    const secret = randomBytes(16);
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
    const spki = new Uint8Array(publicKey.export({ type: "spki", format: "der" }) as Buffer);

    const expected = signedSha1Hex(serverId, secret, spki);
    expect(await computeServerHash(serverId, secret, spki)).toBe(expected);
  });

  test("computeServerHash covers positive and negative (high-bit) digests", async () => {
    let coveredNegative = false;
    let coveredPositive = false;
    for (let i = 0; i < 60 && !(coveredNegative && coveredPositive); i++) {
      const secret = randomBytes(16);
      const spki = new Uint8Array(randomBytes(42)); // arbitrary public-key bytes
      const hash = await computeServerHash("test", secret, spki);
      expect(hash).toBe(signedSha1Hex("test", secret, spki));
      if (hash.startsWith("-")) coveredNegative = true;
      else coveredPositive = true;
    }
    expect(coveredNegative).toBe(true);
    expect(coveredPositive).toBe(true);
  });
});

/** Independent reference: Java `new BigInteger(sha1(...)).toString(16)`. */
function signedSha1Hex(serverId: string, secret: Uint8Array, publicKey: Uint8Array): string {
  const digest = createHash("sha1")
    .update(Buffer.from(serverId, "utf8"))
    .update(Buffer.from(secret))
    .update(Buffer.from(publicKey))
    .digest();
  let value = 0n;
  for (const byte of digest) value = (value << 8n) | BigInt(byte);
  if ((digest[0] & 0x80) !== 0) value -= 1n << 160n;
  return value.toString(16);
}
