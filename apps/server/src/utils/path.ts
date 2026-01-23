import path from 'node:path';

const WINDOWS_DRIVE_REGEX = /^[A-Za-z]:/;

export function fileNameFromAnyPath(value: string): string {
  if (!value) return '';

  const isWindows =
    value.startsWith('\\\\') ||
    WINDOWS_DRIVE_REGEX.test(value) ||
    (value.includes('\\') && !value.includes('/'));

  return isWindows ? path.win32.basename(value) : path.posix.basename(value);
}
