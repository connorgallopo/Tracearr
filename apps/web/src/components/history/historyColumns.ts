import { HISTORY_COLUMNS, type ColumnVisibility } from './HistoryFilters';

export const COLUMN_WIDTHS = {
  date: 140,
  user: 150,
  profile: 130,
  // an explicit share, or fixed layout hands this column every spare pixel
  content: '26%',
  server: 150,
  platform: 130,
  location: 170,
  ip: 130,
  quality: 140,
  // room for its sort button, which would otherwise spill past the column at the min width
  duration: 120,
  progress: 110,
} as const;

type HistoryTableColumn = keyof typeof COLUMN_WIDTHS;

// Fixed layout shrinks the content share to whatever the other columns leave, so the
// table keeps at least this much for it and scrolls sideways when even the fitted columns
// do not fit.
const CONTENT_MIN_WIDTH = 280;

export function getVisibleColumns(
  columnVisibility: ColumnVisibility,
  isMultiServer: boolean,
  showProfile: boolean
): HistoryTableColumn[] {
  const columns: HistoryTableColumn[] = HISTORY_COLUMNS.map((column) => column.id).filter(
    (id) => columnVisibility[id] && (id !== 'server' || isMultiServer)
  );
  return showProfile ? [...columns, 'profile'] : columns;
}

export function getTableMinWidth(columns: HistoryTableColumn[]): number {
  return columns.reduce(
    (sum, column) => sum + (column === 'content' ? CONTENT_MIN_WIDTH : COLUMN_WIDTHS[column]),
    0
  );
}
