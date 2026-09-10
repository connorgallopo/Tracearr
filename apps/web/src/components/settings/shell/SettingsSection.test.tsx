import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SettingsSection } from './SettingsSection';

describe('SettingsSection', () => {
  it('renders the title as a level 2 heading above its children', () => {
    render(
      <SettingsSection title="Appearance">
        <p>body</p>
      </SettingsSection>
    );

    expect(screen.getByRole('heading', { level: 2, name: 'Appearance' })).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('renders the description when given one and nothing when not', () => {
    const { rerender } = render(
      <SettingsSection title="Backup" description="Snapshots of the database.">
        <p>body</p>
      </SettingsSection>
    );
    expect(screen.getByText('Snapshots of the database.')).toBeInTheDocument();

    rerender(
      <SettingsSection title="Backup">
        <p>body</p>
      </SettingsSection>
    );
    expect(screen.queryByText('Snapshots of the database.')).not.toBeInTheDocument();
  });

  it('puts the actions slot in the header', () => {
    render(
      <SettingsSection title="Connections" actions={<button type="button">Add server</button>}>
        <p>body</p>
      </SettingsSection>
    );

    const action = screen.getByRole('button', { name: 'Add server' });
    expect(
      screen.getByRole('heading', { level: 2, name: 'Connections' }).parentElement?.parentElement
    ).toContainElement(action);
  });
});
