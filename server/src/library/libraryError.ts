/**
 * An error whose message is a Vietnamese sentence safe to show in the board:
 * no paths outside what the user already sees, no command output, no secrets.
 * Any other error from a library service is reported with the generic reason.
 */
export class LibraryUserError extends Error {
  override name = 'LibraryUserError';
}
