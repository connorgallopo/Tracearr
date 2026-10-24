import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const SERVER_SRC = fileURLToPath(new URL('..', import.meta.url));

/** Non-test source files under src/, relative and with forward slashes, db/sessions/ excluded. */
export function sourceFiles(): string[] {
  return readdirSync(SERVER_SRC, { recursive: true, encoding: 'utf8' })
    .map((path) => path.split('\\').join('/'))
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.test.ts') &&
        !path.includes('__tests__/') &&
        !path.startsWith('test/') &&
        !path.startsWith('db/sessions/')
    );
}

export function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}
