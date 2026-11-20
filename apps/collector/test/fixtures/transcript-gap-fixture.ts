import { appendFile, stat } from "node:fs/promises";

export async function appendTranscriptBytes(file: string, bytes: string | Buffer) {
  const startOffset = (await stat(file)).size;
  await appendFile(file, bytes);
  return { startOffset, endOffset: startOffset + Buffer.byteLength(bytes) };
}
