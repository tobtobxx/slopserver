// gzip in/out of byte streams via the platform CompressionStream. The casts
// paper over the TS 6 mismatch between Uint8Array<ArrayBufferLike> stream
// generics and the BufferSource-typed DOM streams; the runtime types agree.

type Bytes = ReadableWritablePair<Uint8Array, Uint8Array>;

export function gzipStream(
  s: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return s.pipeThrough(new CompressionStream("gzip") as unknown as Bytes);
}

export function gunzipStream(
  s: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return s.pipeThrough(new DecompressionStream("gzip") as unknown as Bytes);
}

export async function gzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function gunzipBytes(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
