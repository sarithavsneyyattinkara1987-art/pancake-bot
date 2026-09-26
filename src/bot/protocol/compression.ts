/**
 * Async zlib (RFC 1950) codec abstraction.
 *
 * Minecraft compression uses zlib-wrapped deflate. The browser build uses the
 * standard CompressionStream/DecompressionStream APIs; the Node/Termux CLI
 * injects a node:zlib backed implementation. Keeping this behind an interface
 * means the protocol layer never imports node built-ins (so the web bundle
 * stays clean) and never blocks the event loop on large chunks.
 */
export interface ZlibCodec {
  compress(data: Uint8Array): Promise<Uint8Array>;
  decompress(data: Uint8Array): Promise<Uint8Array>;
}

function getTransform(
  format: CompressionFormat,
  stream: ReadableStream<Uint8Array>,
  mode: "compress" | "decompress",
) {
  const Ctor = mode === "compress" ? CompressionStream : DecompressionStream;
  return stream.pipeThrough(
    new Ctor(format) as unknown as ReadableWritablePair<Uint8Array, Uint8Array>,
  );
}

async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** Browser-native zlib codec (deflate = zlib wrapper, deflate-raw = raw). */
export const browserZlib: ZlibCodec = {
  async compress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as unknown as BlobPart]).stream();
    const piped = getTransform("deflate", stream as ReadableStream<Uint8Array>, "compress");
    return streamToBytes(piped);
  },
  async decompress(data: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([data as unknown as BlobPart]).stream();
    const piped = getTransform(
      "deflate",
      stream as unknown as ReadableStream<Uint8Array>,
      "decompress",
    );
    return streamToBytes(piped);
  },
};

/** Create a codec, preferring the environment's native implementation. */
export async function defaultZlib(): Promise<ZlibCodec> {
  if (typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined") {
    return browserZlib;
  }
  throw new Error(
    "No zlib implementation available: inject a ZlibCodec (e.g. node:zlib) for this runtime",
  );
}
