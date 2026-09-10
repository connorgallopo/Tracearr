import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockStatSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('node:fs', () => ({
  statSync: (...args: unknown[]) => mockStatSync(...args) as unknown,
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args) as unknown,
}));

async function importFresh(): Promise<typeof import('../emailLogo.js')> {
  vi.resetModules();
  return import('../emailLogo.js');
}

const CUSTOM = join(process.cwd(), 'data', 'logo.png');

/** statSync answers for the given paths and throws ENOENT for every other one. */
function present(mtimes: Record<string, number>) {
  mockStatSync.mockImplementation((path: string) => {
    const mtimeMs = mtimes[path];
    if (mtimeMs === undefined) throw new Error('ENOENT');
    return { mtimeMs };
  });
}

beforeEach(() => {
  mockStatSync.mockReset();
  mockReadFileSync.mockReset();
  vi.restoreAllMocks();
});

describe('readLogoPng', () => {
  it('prefers the owner logo in data/ and reads it once while its mtime holds', async () => {
    const { readLogoPng, BUNDLED_LOGO_PATH } = await importFresh();
    present({ [CUSTOM]: 100, [BUNDLED_LOGO_PATH]: 1 });
    mockReadFileSync.mockReturnValue(Buffer.from('owner'));

    expect(readLogoPng()).toEqual(Buffer.from('owner'));
    expect(readLogoPng()).toEqual(Buffer.from('owner'));
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockReadFileSync).toHaveBeenCalledWith(CUSTOM);
  });

  it('falls back to the bundled PNG when data/logo.png is absent', async () => {
    const { readLogoPng, logoPngPath, BUNDLED_LOGO_PATH } = await importFresh();
    present({ [BUNDLED_LOGO_PATH]: 1 });
    mockReadFileSync.mockReturnValue(Buffer.from('bundled'));

    expect(logoPngPath()).toBe(BUNDLED_LOGO_PATH);
    expect(readLogoPng()).toEqual(Buffer.from('bundled'));
    expect(mockReadFileSync).toHaveBeenCalledWith(BUNDLED_LOGO_PATH);
  });

  it('finds the bundled PNG from the module, not from the working directory', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/somewhere/else');
    const { logoPngPath, BUNDLED_LOGO_PATH } = await importFresh();
    present({ [BUNDLED_LOGO_PATH]: 1 });

    expect(BUNDLED_LOGO_PATH.startsWith('/somewhere/else')).toBe(false);
    expect(BUNDLED_LOGO_PATH.endsWith(join('assets', 'logo.png'))).toBe(true);
    expect(logoPngPath()).toBe(BUNDLED_LOGO_PATH);
  });

  it('ships the bundled PNG on disk', async () => {
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { BUNDLED_LOGO_PATH } = await importFresh();
    const bytes = fs.readFileSync(BUNDLED_LOGO_PATH);
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  });

  it('re-reads the owner logo once its mtime changes', async () => {
    const { readLogoPng } = await importFresh();
    mockStatSync.mockReturnValueOnce({ mtimeMs: 100 }).mockReturnValueOnce({ mtimeMs: 200 });
    mockReadFileSync
      .mockReturnValueOnce(Buffer.from('logo-a'))
      .mockReturnValueOnce(Buffer.from('logo-b'));

    expect(readLogoPng()).toEqual(Buffer.from('logo-a'));
    expect(readLogoPng()).toEqual(Buffer.from('logo-b'));
  });

  it('returns null when the file cannot be read and tries again on the next call', async () => {
    const { readLogoPng } = await importFresh();
    mockStatSync.mockReturnValue({ mtimeMs: 100 });
    mockReadFileSync.mockImplementationOnce(() => {
      throw new Error('EACCES');
    });

    expect(readLogoPng()).toBeNull();
    mockReadFileSync.mockReturnValue(Buffer.from('logo-a'));
    expect(readLogoPng()).toEqual(Buffer.from('logo-a'));
  });

  it('returns null without reading anything when neither file exists', async () => {
    const { readLogoPng, logoPngPath } = await importFresh();
    present({});

    expect(logoPngPath()).toBeNull();
    expect(readLogoPng()).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});
