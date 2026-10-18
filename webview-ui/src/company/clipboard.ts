/**
 * Copy text to the clipboard. Resolves to whether the copy happened: a missing or
 * refused clipboard is an ordinary outcome the UI reports, never an exception.
 */

/** The part of the async clipboard this app uses; this build's DOM typing does not declare it. */
interface TextClipboard {
  writeText(text: string): Promise<void>;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    const host = globalThis.navigator as Navigator & { clipboard?: TextClipboard };
    const clipboard = host.clipboard;
    if (clipboard === undefined) return false;
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
