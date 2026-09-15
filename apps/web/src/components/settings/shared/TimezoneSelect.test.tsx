import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimezoneSelect, browserTimeZone } from './TimezoneSelect';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('TimezoneSelect', () => {
  it('shows the current zone and offers every IANA zone grouped by region', async () => {
    const onChange = vi.fn();
    render(<TimezoneSelect value="Europe/Berlin" onChange={onChange} id="tz" />);
    expect(screen.getByRole('combobox')).toHaveTextContent('Europe/Berlin');

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.type(screen.getByPlaceholderText('shared.timezone.search'), 'Tokyo');
    await userEvent.click(screen.getByRole('option', { name: /Asia\/Tokyo/ }));
    expect(onChange).toHaveBeenCalledWith('Asia/Tokyo');
  });

  it('keeps a stored alias the browser does not list, so the row stays editable', async () => {
    render(<TimezoneSelect value="US/Eastern" onChange={vi.fn()} />);
    expect(screen.getByRole('combobox')).toHaveTextContent('US/Eastern');
    await userEvent.click(screen.getByRole('combobox'));
    expect(screen.getByRole('option', { name: /US\/Eastern/ })).toBeInTheDocument();
  });

  it('reads the browser zone for a new row', () => {
    expect(browserTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  });
});
