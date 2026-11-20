// Column definitions for visibility toggle
export const HISTORY_COLUMNS = [
  { id: 'date', labelKey: 'common:labels.date', defaultVisible: true },
  { id: 'user', labelKey: 'common:labels.user', defaultVisible: true },
  { id: 'content', labelKey: 'common:labels.content', defaultVisible: true },
  { id: 'server', labelKey: 'common:labels.server', defaultVisible: true },
  { id: 'platform', labelKey: 'common:labels.platform', defaultVisible: true },
  { id: 'location', labelKey: 'common:labels.location', defaultVisible: true },
  { id: 'ip', labelKey: 'common:labels.ipAddress', defaultVisible: false },
  { id: 'quality', labelKey: 'common:labels.quality', defaultVisible: true },
  { id: 'duration', labelKey: 'pages:history.columns.duration', defaultVisible: true },
  { id: 'progress', labelKey: 'pages:history.columns.progress', defaultVisible: true },
] as const;

export type HistoryColumnId = (typeof HISTORY_COLUMNS)[number]['id'];
export type ColumnVisibility = Record<HistoryColumnId, boolean>;

export const DEFAULT_COLUMN_VISIBILITY: ColumnVisibility = Object.fromEntries(
  HISTORY_COLUMNS.map((col) => [col.id, col.defaultVisible])
) as ColumnVisibility;

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

export const NARROW_HIDDEN_COLUMNS: readonly HistoryColumnId[] = ['quality', 'progress'];

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
