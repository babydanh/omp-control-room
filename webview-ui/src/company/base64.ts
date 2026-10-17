/**
 * Base64 helpers shared by the artifact viewer and the file reader.
 *
 * The wire carries bytes as base64 in three places (`companyArtifactPage`,
 * `companyFileRead` with `encoding: 'base64'`, and terminal frames).
 * Decoding through a binary STRING is what mangles a multi-byte UTF-8
 * sequence that straddles a page boundary, so every decode here produces real
 * bytes and the caller decides how to interpret them.
 */

/** Decode standard base64 into bytes. Throws on input atob cannot read. */
export function decodeBase64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
