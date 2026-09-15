import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../settings.js', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
vi.mock('../userService.js', () => ({ getOwnerUser: vi.fn() }));
vi.mock('../../utils/buildInfo.js', () => ({ getCurrentVersion: vi.fn() }));

import { getSetting, setSetting } from '../settings.js';
import { getOwnerUser } from '../userService.js';
import { getCurrentVersion } from '../../utils/buildInfo.js';
import { dismissWhatsNew, getWhatsNewState, seedWhatsNewLastSeen } from '../whatsNew.js';

describe('whatsNew service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentVersion).mockReturnValue('v2.3.0');
  });

  it('marks an existing install legacy on first boot', async () => {
    vi.mocked(getSetting).mockResolvedValue(null as never);
    vi.mocked(getOwnerUser).mockResolvedValue({ id: 'owner' } as never);
    await seedWhatsNewLastSeen();
    expect(setSetting).toHaveBeenCalledWith('whatsNewLastSeenVersion', 'legacy');
  });

  it('marks a fresh install as already seen on the running version', async () => {
    vi.mocked(getSetting).mockResolvedValue(null as never);
    vi.mocked(getOwnerUser).mockResolvedValue(null);
    await seedWhatsNewLastSeen();
    expect(setSetting).toHaveBeenCalledWith('whatsNewLastSeenVersion', '2.3.0');
  });

  it('never overwrites a stored value', async () => {
    vi.mocked(getSetting).mockResolvedValue('2.2.0' as never);
    await seedWhatsNewLastSeen();
    expect(setSetting).not.toHaveBeenCalled();
  });

  it('reports state and dismisses with the normalized running version', async () => {
    vi.mocked(getSetting).mockResolvedValue('legacy' as never);
    await expect(getWhatsNewState()).resolves.toEqual({
      runningVersion: '2.3.0',
      lastSeenVersion: 'legacy',
    });
    await dismissWhatsNew();
    expect(setSetting).toHaveBeenCalledWith('whatsNewLastSeenVersion', '2.3.0');
  });
});
