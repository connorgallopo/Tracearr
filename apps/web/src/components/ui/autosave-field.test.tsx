import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AutosaveNumberField, AutosaveSelectField, AutosaveTextField } from './autosave-field';

describe('AutosaveNumberField', () => {
  it('puts the unit in the input group, at its trailing edge', () => {
    render(
      <AutosaveNumberField
        id="pollerIntervalMs"
        label="Sync interval"
        value={15}
        onChange={vi.fn()}
        suffix="sec"
        status="idle"
      />
    );

    const group = screen.getByLabelText('Sync interval').closest('[data-slot="input-group"]');
    expect(group).not.toBeNull();
    expect(group?.querySelector('[data-align="inline-end"]')).toHaveTextContent('sec');
  });

  it('renders no addon when the field carries no unit', () => {
    render(
      <AutosaveNumberField id="count" label="Count" value={3} onChange={vi.fn()} status="idle" />
    );

    const group = screen.getByLabelText('Count').closest('[data-slot="input-group"]');
    expect(group?.querySelector('[data-slot="input-group-addon"]')).toBeNull();
  });

  it('still reports the typed number', async () => {
    const onChange = vi.fn();
    render(
      <AutosaveNumberField id="count" label="Count" value={3} onChange={onChange} status="idle" />
    );

    await userEvent.type(screen.getByLabelText('Count'), '9');

    expect(onChange).toHaveBeenCalledWith(39);
  });
});

describe('AutosaveTextField', () => {
  it('renders a trailing slot beside the input, not somewhere else in the field', () => {
    render(
      <AutosaveTextField
        id="externalUrl"
        label="External URL"
        value="https://example.com"
        onChange={vi.fn()}
        status="idle"
        trailing={<button type="button">Detect</button>}
      />
    );

    const input = screen.getByLabelText('External URL');
    const trailingButton = screen.getByRole('button', { name: 'Detect' });
    expect(trailingButton.parentElement).toBe(input.parentElement);
  });

  it('renders no trailing wrapper when the slot is empty', () => {
    render(
      <AutosaveTextField
        id="externalUrl"
        label="External URL"
        value="https://example.com"
        onChange={vi.fn()}
        status="idle"
      />
    );

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('AutosaveSelectField', () => {
  it('still reports the chosen option', async () => {
    const onChange = vi.fn();
    render(
      <AutosaveSelectField
        id="unitSystem"
        label="Unit system"
        value="metric"
        onChange={onChange}
        options={[
          { value: 'metric', label: 'Metric' },
          { value: 'imperial', label: 'Imperial' },
        ]}
        status="idle"
      />
    );

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Imperial' }));

    expect(onChange).toHaveBeenCalledWith('imperial');
  });
});
