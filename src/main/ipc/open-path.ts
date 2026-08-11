/**
 * Wraps Electron's `shell.openPath`, which resolves to an error string when the
 * path cannot be opened. Convert a non-empty error string into a rejected
 * promise so callers can surface a localized failure instead of silently
 * treating it as success.
 */
export async function openPathOrThrow(
  openPath: (path: string) => Promise<string>,
  path: string
): Promise<void> {
  const errorMessage = await openPath(path)
  if (errorMessage) throw new Error(errorMessage)
}
