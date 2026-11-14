import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: object) => (options ? `${key}:${JSON.stringify(options)}` : key),
  }),
  Trans: ({ i18nKey, values }: { i18nKey: string; values: object }) =>
    `${i18nKey}:${JSON.stringify(values)}`,
}));

import { TofaServerPicker, TofaWaiting } from './TofaSignIn';

const attic = { id: 'srv-1', name: 'Attic', online: true, localAddress: 'http://10.0.0.5:33333' };

describe('TofaSignIn', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waiting shows approve, open again, the expiry and the fallback code', () => {
    vi.useFakeTimers({ now: 0 });
    render(
      <TofaWaiting
        verificationUri="https://app.tofa.tv/link?code=ABCD-EFGH"
        userCode="ABCD-EFGH"
        expiresAt={522_000}
      />
    );

    expect(screen.getByText('pages:tofa.waiting')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'pages:tofa.openAgain' })).toHaveAttribute(
      'href',
      'https://app.tofa.tv/link?code=ABCD-EFGH'
    );
    expect(screen.getByText('pages:tofa.expiresIn:{"time":"8:42"}')).toBeInTheDocument();
    expect(screen.getByText('pages:tofa.codeFallback:{"code":"ABCD-EFGH"}')).toBeInTheDocument();
  });

  it('an unreachable server shows the address and a URL field', async () => {
    const onConnect = vi.fn();
    render(
      <TofaServerPicker
        servers={[attic]}
        connectingTo={null}
        unreachable={{ serverId: 'srv-1', address: 'http://10.0.0.5:33333' }}
        onConnect={onConnect}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent(
      'pages:tofa.unreachable:{"name":"Attic","address":"10.0.0.5:33333"}'
    );
    await userEvent.type(screen.getByLabelText('settings:servers.serverUrl'), 'attic.lan:33333');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.connect' }));

    expect(onConnect).toHaveBeenCalledWith('srv-1', 'http://attic.lan:33333');
  });

  it('disables every Connect while one server connects', () => {
    render(
      <TofaServerPicker
        servers={[attic, { ...attic, id: 'srv-2', name: 'Den' }]}
        connectingTo="srv-1"
        unreachable={null}
        onConnect={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: /common:states.connecting/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'common:actions.connect' })).toBeDisabled();
  });
});
