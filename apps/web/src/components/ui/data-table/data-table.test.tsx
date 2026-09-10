import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SortingState } from '@tanstack/react-table';
import { createDataTableColumnHelper } from './features';
import {
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTableRoot,
  DataTableViewport,
  type DataTableDensity,
  type DataTableHeaderVariant,
} from './data-table';
import { DataTablePager } from './data-table-pager';
import { useDataTable, type UseDataTableOptions } from './use-data-table';
import type { DataTableInstance } from './features';

interface Person {
  id: string;
  name: string;
  age: number;
}

const helper = createDataTableColumnHelper<Person>();
const columns = helper.columns([
  helper.accessor('name', {
    header: 'Name',
    meta: { width: '12rem', headerClassName: 'test-head', cellClassName: 'hidden md:table-cell' },
  }),
  helper.accessor('age', { header: 'Age', enableSorting: false, meta: { numeric: true } }),
]);

const cellAction = vi.fn();
const actionColumns = helper.columns([
  helper.accessor('name', { header: 'Name' }),
  helper.display({
    id: 'action',
    header: 'Action',
    // Call sites keep the click off the row themselves; the key press is the table's job.
    cell: ({ row }) => (
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          cellAction();
        }}
      >
        Act on {row.original.name}
      </button>
    ),
  }),
]);

const people: Person[] = [
  { id: 'a', name: 'Charlie', age: 30 },
  { id: 'b', name: 'Alpha', age: 21 },
  { id: 'c', name: 'Bravo', age: 44 },
];

const getRowId = (row: Person) => row.id;

const pagerLabels = {
  navigation: 'Pagination',
  status: 'Page status',
  previous: 'Previous',
  next: 'Next',
};

interface HarnessProps extends Omit<UseDataTableOptions<Person>, 'columns' | 'getRowId'> {
  onRowClick?: (row: Person) => void;
  isLoading?: boolean;
  density?: DataTableDensity;
  headerVariant?: DataTableHeaderVariant;
  flush?: boolean;
  /** Swaps in the column holding a button, the shape an interactive cell takes. */
  withAction?: boolean;
}

function Harness({
  onRowClick,
  isLoading,
  density,
  headerVariant,
  flush,
  withAction,
  ...options
}: HarnessProps) {
  const { table, pager } = useDataTable<Person>({
    ...options,
    columns: withAction ? actionColumns : columns,
    getRowId,
  });

  return (
    <DataTableRoot density={density} headerVariant={headerVariant}>
      <DataTableViewport flush={flush}>
        <DataTableHeader table={table} />
        <DataTableBody
          table={table}
          isLoading={isLoading}
          loadingLabel="Loading rows"
          onRowClick={onRowClick}
          empty={<DataTableEmpty table={table} title="Nothing here" description="Try again" />}
        />
      </DataTableViewport>
      <DataTablePager {...pager} labels={{ ...pagerLabels, status: `Page ${pager.page}` }} />
    </DataTableRoot>
  );
}

function rowNames() {
  const body = screen.getAllByRole('rowgroup')[1]!;
  return within(body)
    .getAllByRole('row')
    .map((row) => within(row).getAllByRole('cell')[0]!.textContent);
}

describe('data-table manual mode', () => {
  it('renders every loaded row under server pagination instead of slicing', () => {
    render(<Harness data={people} pageSize={2} page={4} pageCount={9} onPageChange={vi.fn()} />);

    expect(rowNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('slices locally when no server pagination is wired up', () => {
    render(<Harness data={people} pageSize={2} />);

    expect(rowNames()).toEqual(['Charlie', 'Alpha']);
  });

  it('leaves row order untouched when sorting is served', () => {
    render(
      <Harness data={people} sorting={[{ id: 'name', desc: false }]} onSortingChange={vi.fn()} />
    );

    expect(rowNames()).toEqual(['Charlie', 'Alpha', 'Bravo']);
  });

  it('sorts locally when no sorting callback is wired up', async () => {
    const user = userEvent.setup();
    render(<Harness data={people} />);

    await user.click(screen.getByRole('button', { name: 'Name' }));

    expect(rowNames()).toEqual(['Alpha', 'Bravo', 'Charlie']);
  });

  it('reports the flipped sort direction to the server callback', async () => {
    const user = userEvent.setup();
    const onSortingChange = vi.fn<(sorting: SortingState) => void>();
    render(
      <Harness
        data={people}
        sorting={[{ id: 'name', desc: false }]}
        onSortingChange={onSortingChange}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Name' }));

    expect(onSortingChange).toHaveBeenCalledWith([{ id: 'name', desc: true }]);
  });

  it('marks the sorted column with aria-sort and leaves opted-out columns alone', () => {
    render(
      <Harness data={people} sorting={[{ id: 'name', desc: true }]} onSortingChange={vi.fn()} />
    );

    const [nameHeader, ageHeader] = screen.getAllByRole('columnheader');
    expect(nameHeader).toHaveAttribute('aria-sort', 'descending');
    expect(within(nameHeader!).getByRole('button', { name: 'Name' })).toBeInTheDocument();
    expect(ageHeader).not.toHaveAttribute('aria-sort');
    expect(within(ageHeader!).queryByRole('button')).toBeNull();
  });
});

describe('data-table pagination controls', () => {
  it('hides itself when there is only one page', () => {
    render(<Harness data={people} pageSize={10} page={1} pageCount={1} onPageChange={vi.fn()} />);

    expect(screen.queryByRole('navigation', { name: 'Pagination' })).toBeNull();
  });

  it('sends the next and previous page numbers to the server callback', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn<(page: number) => void>();
    render(
      <Harness data={people} pageSize={2} page={3} pageCount={9} onPageChange={onPageChange} />
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(onPageChange).toHaveBeenCalledWith(4);

    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('walks client pages without a server callback', async () => {
    const user = userEvent.setup();
    render(<Harness data={people} pageSize={2} />);

    expect(rowNames()).toEqual(['Charlie', 'Alpha']);
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(rowNames()).toEqual(['Bravo']);
    await user.click(screen.getByRole('button', { name: 'Previous' }));
    expect(rowNames()).toEqual(['Charlie', 'Alpha']);
  });

  it('disables the edges of the range', () => {
    render(<Harness data={people} pageSize={2} page={1} pageCount={2} onPageChange={vi.fn()} />);

    expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled();
  });
});

describe('data-table states', () => {
  it('renders a skeleton that mirrors the column layout', () => {
    render(<Harness data={people} isLoading />);

    const body = screen.getByLabelText('Loading rows');
    const rows = within(body).getAllByRole('row');
    expect(rows).toHaveLength(5);
    expect(within(rows[0]!).getAllByRole('cell')).toHaveLength(2);
    expect(screen.queryByText('Charlie')).toBeNull();
  });

  it('renders the rich empty state with its own title and description', () => {
    render(<Harness data={[]} />);

    expect(screen.getByRole('heading', { name: 'Nothing here' })).toBeInTheDocument();
    expect(screen.getByText('Try again')).toBeInTheDocument();
  });
});

describe('data-table column meta', () => {
  it('applies width, per-column classes and numeric alignment', () => {
    render(<Harness data={people} />);

    const [nameHeader, ageHeader] = screen.getAllByRole('columnheader');
    expect(nameHeader?.style.width).toBe('12rem');
    expect(nameHeader).toHaveClass('test-head');
    expect(ageHeader?.className).toContain('text-right');
    expect(ageHeader?.className).toContain('tabular-nums');

    const body = screen.getAllByRole('rowgroup')[1]!;
    const [nameCell, ageCell] = within(within(body).getAllByRole('row')[0]!).getAllByRole('cell');
    expect(nameCell?.style.width).toBe('12rem');
    expect(nameCell?.className).toContain('hidden');
    expect(ageCell?.className).toContain('tabular-nums');
  });
});

describe('data-table row interaction', () => {
  it('activates a clickable row with the mouse, Enter and Space', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn<(row: Person) => void>();
    render(<Harness data={people} onRowClick={onRowClick} />);

    const body = screen.getAllByRole('rowgroup')[1]!;
    const firstRow = within(body).getAllByRole('row')[0]!;
    expect(firstRow).toHaveAttribute('tabindex', '0');

    await user.click(firstRow);
    expect(onRowClick).toHaveBeenCalledWith(people[0]);

    firstRow.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onRowClick).toHaveBeenCalledTimes(3);
  });

  it('leaves rows inert when no click handler is given', () => {
    render(<Harness data={people} />);

    const body = screen.getAllByRole('rowgroup')[1]!;
    expect(within(body).getAllByRole('row')[0]!).not.toHaveAttribute('tabindex');
  });

  it('activates the focused control instead of the row it sits in', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn<(row: Person) => void>();
    render(<Harness data={people} onRowClick={onRowClick} withAction />);

    screen.getByRole('button', { name: 'Act on Charlie' }).focus();
    await user.keyboard('{Enter}');

    expect(cellAction).toHaveBeenCalledTimes(1);
    expect(onRowClick).not.toHaveBeenCalled();
  });
});

const selectionLabels = { selectAllOnPage: 'Select all on page', selectRow: 'Select row' };

interface SelectionHarnessProps {
  selectedIds: Set<string>;
  selectAllMode?: boolean;
  onToggleRow?: (row: Person) => void;
  onTogglePage?: (rows: Person[]) => void;
  onRowClick?: (row: Person) => void;
  capture?: { table?: DataTableInstance<Person> };
}

function SelectionHarness({
  selectedIds,
  selectAllMode,
  onToggleRow = vi.fn(),
  onTogglePage = vi.fn(),
  onRowClick,
  capture,
}: SelectionHarnessProps) {
  const { table } = useDataTable<Person>({
    columns,
    data: people,
    getRowId,
    page: 2,
    pageCount: 5,
    pageSize: 3,
    onPageChange: vi.fn(),
    selection: {
      selectedIds,
      selectAllMode,
      onToggleRow,
      onTogglePage,
      labels: selectionLabels,
    },
  });
  if (capture) capture.table = table;

  return (
    <DataTableRoot>
      <DataTableViewport>
        <DataTableHeader table={table} />
        <DataTableBody table={table} onRowClick={onRowClick} />
      </DataTableViewport>
    </DataTableRoot>
  );
}

describe('data-table selection', () => {
  it('renders the header checkbox indeterminate when only some page rows are selected', () => {
    render(<SelectionHarness selectedIds={new Set(['a'])} />);

    const header = screen.getByRole('checkbox', { name: 'Select all on page' });
    expect(header).toHaveAttribute('aria-checked', 'mixed');
    expect(header).toHaveAttribute('data-state', 'indeterminate');
  });

  it('renders the header checkbox checked once every page row is selected', () => {
    render(<SelectionHarness selectedIds={new Set(['a', 'b', 'c'])} />);

    expect(screen.getByRole('checkbox', { name: 'Select all on page' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
  });

  it('hands the loaded rows to the page toggle', async () => {
    const user = userEvent.setup();
    const onTogglePage = vi.fn<(rows: Person[]) => void>();
    render(<SelectionHarness selectedIds={new Set()} onTogglePage={onTogglePage} />);

    await user.click(screen.getByRole('checkbox', { name: 'Select all on page' }));

    expect(onTogglePage).toHaveBeenCalledWith(people);
  });

  it('toggles a row without firing the row click', async () => {
    const user = userEvent.setup();
    const onToggleRow = vi.fn<(row: Person) => void>();
    const onRowClick = vi.fn<(row: Person) => void>();
    render(
      <SelectionHarness selectedIds={new Set()} onToggleRow={onToggleRow} onRowClick={onRowClick} />
    );

    await user.click(screen.getAllByRole('checkbox', { name: 'Select row' })[1]!);

    expect(onToggleRow).toHaveBeenCalledWith(people[1]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('keeps the space key on a row checkbox off the row activation path', async () => {
    const user = userEvent.setup();
    const onToggleRow = vi.fn<(row: Person) => void>();
    const onRowClick = vi.fn<(row: Person) => void>();
    render(
      <SelectionHarness selectedIds={new Set()} onToggleRow={onToggleRow} onRowClick={onRowClick} />
    );

    screen.getAllByRole('checkbox', { name: 'Select row' })[0]!.focus();
    await user.keyboard(' ');

    expect(onToggleRow).toHaveBeenCalledWith(people[0]);
    expect(onRowClick).not.toHaveBeenCalled();
  });

  it('drops the key on deselect rather than storing false', () => {
    const capture: { table?: DataTableInstance<Person> } = {};
    const { rerender } = render(
      <SelectionHarness selectedIds={new Set(['a', 'b'])} capture={capture} />
    );

    expect(capture.table!.getSelectedRowIds()).toEqual(['a', 'b']);

    rerender(<SelectionHarness selectedIds={new Set(['b'])} capture={capture} />);

    const state = capture.table!.state.rowSelection;
    expect(Object.keys(state)).toEqual(['b']);
    expect(Object.values(state)).toEqual([true]);
    expect(capture.table!.getSelectedRowIds()).toEqual(['b']);
  });

  it('routes a table-driven deselect back through the row toggle', () => {
    const onToggleRow = vi.fn<(row: Person) => void>();
    const capture: { table?: DataTableInstance<Person> } = {};
    render(
      <SelectionHarness
        selectedIds={new Set(['a', 'b', 'c'])}
        onToggleRow={onToggleRow}
        capture={capture}
      />
    );

    capture.table!.toggleAllPageRowsSelected(false);

    expect(onToggleRow.mock.calls.map(([row]) => row)).toEqual(people);
  });

  it('shows every loaded row as selected in select-all mode', () => {
    const capture: { table?: DataTableInstance<Person> } = {};
    render(<SelectionHarness selectedIds={new Set()} selectAllMode capture={capture} />);

    expect(capture.table!.getSelectedRowIds()).toEqual(['a', 'b', 'c']);
    for (const box of screen.getAllByRole('checkbox', { name: 'Select row' })) {
      expect(box).toHaveAttribute('aria-checked', 'true');
    }
  });

  it('counts selection by id, not by the rows the page happens to have loaded', () => {
    const capture: { table?: DataTableInstance<Person> } = {};
    render(
      <SelectionHarness
        selectedIds={new Set(['a', 'off-page-1', 'off-page-2'])}
        capture={capture}
      />
    );

    expect(capture.table!.getSelectedRowIds()).toEqual(['a']);
    expect(capture.table!.getIsSomePageRowsSelected()).toBe(true);
    expect(capture.table!.getIsAllPageRowsSelected()).toBe(false);
  });
});

describe('data-table chrome', () => {
  function firstCell() {
    const body = screen.getAllByRole('rowgroup')[1]!;
    return within(within(body).getAllByRole('row')[0]!).getAllByRole('cell')[0]!;
  }

  it.each([
    ['comfortable' as const, 'py-4'],
    ['default' as const, 'py-3'],
    ['compact' as const, 'py-1.5'],
  ])('applies %s density to body cells', (density, expected) => {
    render(<Harness data={people} density={density} />);
    expect(firstCell().className).toContain(expected);
  });

  it('sets density once on the root rather than per column', () => {
    render(<Harness data={people} density="compact" />);
    // The column defs carry no density; only the shared meta classes survive.
    expect(firstCell().className).toContain('hidden md:table-cell');
    expect(firstCell().className).toContain('px-3');
  });

  it('swaps the header type scale without touching cell density', () => {
    render(<Harness data={people} headerVariant="micro" />);
    const head = screen.getAllByRole('columnheader')[0]!;
    expect(head.className).toContain('text-[10.5px]');
    expect(head.className).toContain('tracking-[0.07em]');
    expect(firstCell().className).toContain('py-3');
  });

  it('leaves the header scale alone by default', () => {
    render(<Harness data={people} />);
    expect(screen.getAllByRole('columnheader')[0]!.className).not.toContain('text-[10.5px]');
  });

  it.each([
    ['comfortable' as const, '-mx-4 -mb-4'],
    ['default' as const, '-mx-4 -mb-3'],
    ['compact' as const, '-mx-3 -mb-1.5'],
  ])('cancels %s cell padding when the viewport is flush', (density, expected) => {
    const { container } = render(<Harness data={people} density={density} flush />);
    const viewport = container.querySelector('[data-slot="data-table-viewport"]')!;
    for (const offset of expected.split(' ')) {
      expect(viewport.className).toContain(offset);
    }
  });

  it('leaves the viewport unshifted by default', () => {
    const { container } = render(<Harness data={people} density="compact" />);
    const viewport = container.querySelector('[data-slot="data-table-viewport"]')!;
    expect(viewport.className).not.toContain('-mx-3');
  });
});
