/**
 * Path normalisation shared by git output, the activity ledger and the wire.
 * Git on Windows prints forward slashes, the ledger may hold backslashes, and
 * Windows paths are case-insensitive, so matching goes through ledgerPathKey.
 */

const DRIVE_ROOT_PATTERN = /^[A-Za-z]:\/$/;

/** Forward slashes, no trailing slash (a drive root keeps its slash). */
export function normalizeLedgerPath(raw: string): string {
  const slashed = raw.replace(/\\/g, '/');
  if (DRIVE_ROOT_PATTERN.test(slashed)) return slashed;
  const trimmed = slashed.replace(/\/+$/, '');
  return trimmed === '' && slashed !== '' ? '/' : trimmed;
}

/** Case-insensitive identity of a normalised path. */
export function ledgerPathKey(raw: string): string {
  return normalizeLedgerPath(raw).toLowerCase();
}

/** Last segment of a normalised path. */
export function ledgerBasename(raw: string): string {
  const normalized = normalizeLedgerPath(raw);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}
