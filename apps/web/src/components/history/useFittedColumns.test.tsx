import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { HistoryTable } from './HistoryTable';
import { DEFAULT_COLUMN_VISIBILITY, type HistoryColumnId } from './HistoryFilters';
import { useFittedColumns } from './useFittedColumns';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

describe('useFittedColumns', () => {
  function FittedTable({ chosen }: { chosen?: HistoryColumnId[] }) {
    const { fitRef, columnVisibility } = useFittedColumns(DEFAULT_COLUMN_VISIBILITY, { chosen });
    return (
      <div ref={fitRef}>
        <HistoryTable sessions={[]} columnVisibility={columnVisibility} />
      </div>
    );
  }

  const headers = () => screen.getAllByRole('columnheader').map((header) => header.textContent);

  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops Quality and Progress from a table too narrow for every column', () => {
    render(<FittedTable />);

    expect(headers()).toContain('labels.content');
    expect(headers()).not.toContain('labels.quality');
    expect(headers()).not.toContain('pages:history.columns.progress');
  });

  it('keeps a column the user chose even when the table is narrow', () => {
    render(<FittedTable chosen={['progress']} />);

    expect(headers()).toContain('pages:history.columns.progress');
    expect(headers()).not.toContain('labels.quality');
  });
});
