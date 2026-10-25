import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import type { StorageMountIssue } from '@tracearr/shared';
import { StorageWarningDialog } from './StorageWarningDialog';

const FAQ_URL =
  'https://docs.tracearr.com/getting-started/installation/supervised#why-named-volumes-matter-here';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const postgresOnCache: StorageMountIssue = {
  key: 'postgres',
  fsType: 'fuse.shfs',
  currentPath: '/mnt/user/appdata/tracearr/postgres',
  placement: { kind: 'pool', pool: 'cache', newPath: '/mnt/cache/appdata/tracearr/postgres' },
};

const redisOnFastpool: StorageMountIssue = {
  key: 'redis',
  fsType: 'fuse.shfs',
  currentPath: '/mnt/user/appdata/tracearr/redis',
  placement: { kind: 'pool', pool: 'fastpool', newPath: '/mnt/fastpool/appdata/tracearr/redis' },
};

const postgresSplit: StorageMountIssue = {
  key: 'postgres',
  fsType: 'fuse.shfs',
  currentPath: '/mnt/user/appdata/tracearr/postgres',
  placement: { kind: 'split', disks: ['cache', 'disk1'] },
};

const postgresUnknown: StorageMountIssue = {
  key: 'postgres',
  fsType: 'fuse.shfs',
  currentPath: '/mnt/user/appdata/tracearr/postgres',
  placement: { kind: 'unknown' },
};

function renderDialog(issues: StorageMountIssue[]) {
  render(<StorageWarningDialog issues={issues} open onClose={() => undefined} />);
  return screen.getByRole('dialog');
}

describe('StorageWarningDialog', () => {
  it('lists one step per mount with its own pool', () => {
    const dialog = renderDialog([postgresOnCache, redisOnFastpool]);

    expect(within(dialog).getByText('Move the database off the user share')).toBeInTheDocument();
    const steps = within(dialog).getAllByRole('listitem');
    const change = steps.filter((li) => li.textContent?.startsWith('Change '));
    expect(change).toHaveLength(2);

    const [pg, redis] = change;
    expect(pg).toHaveTextContent('Change PostgreSQL Data to:');
    expect(within(pg!).getByText('/mnt/cache/appdata/tracearr/postgres').tagName).toBe('CODE');
    expect(within(pg!).getByRole('button', { name: /PostgreSQL Data/ })).toBeInTheDocument();

    expect(redis).toHaveTextContent('Change Redis Data to:');
    expect(within(redis!).getByText('/mnt/fastpool/appdata/tracearr/redis').tagName).toBe('CODE');
    expect(within(redis!).getByRole('button', { name: /Redis Data/ })).toBeInTheDocument();

    expect(dialog).toHaveTextContent(
      'Tracearr checks this each time it starts, so this notice clears after the restart.'
    );
  });

  it('calls them Tracearr files when more than the database is listed', () => {
    const dialog = renderDialog([
      postgresOnCache,
      {
        ...redisOnFastpool,
        placement: { kind: 'pool', pool: 'cache', newPath: '/mnt/cache/appdata/tracearr/redis' },
      },
    ]);

    expect(dialog).toHaveTextContent(
      'Your Tracearr files are already on the cache pool, so nothing needs to move.'
    );
    expect(dialog).not.toHaveTextContent('Your database files');
  });

  it('names the pool when every mount shares it', () => {
    const dialog = renderDialog([postgresOnCache]);

    expect(dialog).toHaveTextContent(
      "PostgreSQL Data is set to /mnt/user/appdata/tracearr/postgres. Paths under /mnt/user go through Unraid's FUSE layer (shfs), which adds overhead to every database read and write."
    );
    expect(dialog).toHaveTextContent(
      'Your database files are already on the cache pool, so nothing needs to move. Point Tracearr at that pool directly:'
    );
  });

  it('a split anywhere offers no new path for any mount', () => {
    const dialog = renderDialog([postgresSplit, redisOnFastpool]);

    expect(within(dialog).queryByRole('button', { name: /path/ })).toBeNull();
    expect(dialog).not.toHaveTextContent('/mnt/fastpool');
  });

  it('a split across pools only says so without naming the array', () => {
    const dialog = renderDialog([
      { ...postgresSplit, placement: { kind: 'split', disks: ['cache', 'fastpool'] } },
    ]);

    expect(dialog).toHaveTextContent(
      'Your database is split across several pools (cache, fastpool), so no single pool holds all of it.'
    );
    expect(dialog).not.toHaveTextContent(/array/i);
    expect(within(dialog).queryByRole('button', { name: /path/ })).toBeNull();
  });

  it('names the field when Redis is split', () => {
    const dialog = renderDialog([
      { ...redisOnFastpool, placement: { kind: 'split', disks: ['cache', 'disk2'] } },
    ]);

    expect(dialog).toHaveTextContent('Some files for Redis Data are on the array (disk2)');
  });

  it('keeps the database sentence to where the database actually is', () => {
    const dialog = renderDialog([
      { ...postgresSplit, placement: { kind: 'split', disks: ['cache', 'fastpool'] } },
      { ...redisOnFastpool, placement: { kind: 'split', disks: ['cache', 'disk1'] } },
    ]);

    expect(dialog).toHaveTextContent(
      'Your database is split across several pools (cache, fastpool), so no single pool holds all of it.'
    );
    expect(dialog).toHaveTextContent('Some files for Redis Data are on the array (disk1)');
    expect(dialog).not.toHaveTextContent('Part of your database is on the array');
    expect(dialog).toHaveTextContent('In Main, click Move and wait for it to finish.');
  });

  it('gives the exact path for a pool mount beside an unknown one', () => {
    const dialog = renderDialog([
      {
        ...postgresOnCache,
        placement: {
          kind: 'pool',
          pool: 'fastpool',
          newPath: '/mnt/fastpool/appdata/tracearr/postgres',
        },
      },
      {
        key: 'appData',
        fsType: 'fuse.shfs',
        currentPath: '/mnt/user/appdata/tracearr/data',
        placement: { kind: 'unknown' },
      },
    ]);

    const step = within(dialog).getByText('/mnt/fastpool/appdata/tracearr/postgres').closest('li');
    expect(step).not.toBeNull();
    expect(within(step!).getByRole('button', { name: /PostgreSQL Data/ })).toBeInTheDocument();
    expect(dialog).toHaveTextContent(
      "App Data is set to /mnt/user/appdata/tracearr/data, which goes through Unraid's FUSE layer (shfs) and slows every read and write."
    );
    expect(dialog).not.toHaveTextContent('/mnt/cache');
  });

  it('names the disks and offers no new path when files are on the array', () => {
    const dialog = renderDialog([postgresSplit]);

    expect(dialog).toHaveTextContent(
      "Part of your database is on the array (disk1), so the pool doesn't hold all of it yet. Leave the path as it is for now: pointing Tracearr at a folder that's missing files starts a new, empty database."
    );
    expect(dialog).toHaveTextContent('In Shares, open appdata.');
    expect(dialog).toHaveTextContent('In Main, click Move and wait for it to finish.');
    expect(within(dialog).queryByText(/^\/mnt\/cache/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: /path/ })).toBeNull();
  });

  it("falls back to an example path when the location can't be read", () => {
    const dialog = renderDialog([postgresUnknown]);

    expect(dialog).toHaveTextContent(
      "PostgreSQL Data is set to /mnt/user/appdata/tracearr/postgres, which goes through Unraid's FUSE layer (shfs) and slows every database read and write."
    );
    expect(dialog).toHaveTextContent(
      "If appdata lives on a pool, change PostgreSQL Data in the container's Edit page to the same folder on that pool, for example /mnt/cache/appdata/tracearr/postgres. First check that the folder on the pool contains a file named PG_VERSION. Without it, Tracearr starts a new, empty database."
    );
  });

  it('names the filesystem for a FUSE mount other than shfs', () => {
    const dialog = renderDialog([
      {
        key: 'postgres',
        fsType: 'fuse.mergerfs',
        currentPath: null,
        placement: { kind: 'unknown' },
      },
    ]);

    expect(dialog).toHaveTextContent(
      'PostgreSQL Data is on a fuse.mergerfs mount, a FUSE filesystem that slows every database read and write.'
    );
  });

  it('does not call it the database when only Redis is affected', () => {
    const dialog = renderDialog([redisOnFastpool]);

    expect(within(dialog).getByText("Move Tracearr's data off the user share")).toBeInTheDocument();
    expect(dialog).not.toHaveTextContent(/database/);
  });

  it('paths render inside code with user-select all', () => {
    const dialog = renderDialog([postgresOnCache]);

    for (const path of [
      '/mnt/user/appdata/tracearr/postgres',
      '/mnt/cache/appdata/tracearr/postgres',
    ]) {
      const code = within(dialog).getByText(path);
      expect(code.tagName).toBe('CODE');
      expect(code).toHaveClass('select-all');
      expect(code).not.toHaveClass('break-all');
      expect(code.textContent).toBe(path);
      expect(code.querySelectorAll('wbr')).toHaveLength(path.split('/').length - 1);
    }
    expect(within(dialog).getByText('/mnt/user').tagName).toBe('CODE');
  });

  it('puts the new path on its own row beside the copy button', () => {
    const dialog = renderDialog([postgresOnCache]);

    const code = within(dialog).getByText('/mnt/cache/appdata/tracearr/postgres');
    const row = code.parentElement!;
    expect(row.tagName).toBe('DIV');
    expect(within(row).getByRole('button', { name: /PostgreSQL Data/ })).toBeInTheDocument();
  });

  it('selects the new path when the browser blocks copying', async () => {
    const dialog = renderDialog([postgresOnCache]);

    await userEvent.click(within(dialog).getByRole('button', { name: /PostgreSQL Data/ }));

    expect(window.getSelection()?.toString()).toBe('/mnt/cache/appdata/tracearr/postgres');
  });

  it.each([
    ['pool', [postgresOnCache]],
    ['split', [postgresSplit]],
    ['unknown', [postgresUnknown]],
  ])('each case links the FAQ section (%s)', (_, issues) => {
    const dialog = renderDialog(issues);

    expect(within(dialog).getByRole('link', { name: 'Why user shares are slow' })).toHaveAttribute(
      'href',
      FAQ_URL
    );
  });
});
