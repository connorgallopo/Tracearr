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

beforeEach(() => {
  mockStatSync.mockReset();
  mockReadFileSync.mockReset();
});

describe('readLogoPng', () => {
  it('reuses the cached buffer while the mtime is unchanged', async () => {
    const { readLogoPng } = await importFresh();
    mockStatSync.mockReturnValue({ mtimeMs: 100 });
    mockReadFileSync.mockReturnValue(Buffer.from('logo-a'));

    expect(readLogoPng()).toEqual(Buffer.from('logo-a'));
    expect(readLogoPng()).toEqual(Buffer.from('logo-a'));
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
    expect(mockStatSync).toHaveBeenCalledTimes(2);
  });

  it('re-reads the file once the mtime changes', async () => {
    const { readLogoPng } = await importFresh();
    mockStatSync.mockReturnValueOnce({ mtimeMs: 100 }).mockReturnValueOnce({ mtimeMs: 200 });
    mockReadFileSync
      .mockReturnValueOnce(Buffer.from('logo-a'))
      .mockReturnValueOnce(Buffer.from('logo-b'));

    expect(readLogoPng()).toEqual(Buffer.from('logo-a'));
    expect(readLogoPng()).toEqual(Buffer.from('logo-b'));
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it('returns null without reading the file when statSync throws', async () => {
    const { readLogoPng } = await importFresh();
    mockStatSync.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    expect(readLogoPng()).toBeNull();
    expect(mockReadFileSync).not.toHaveBeenCalled();
  });
});
