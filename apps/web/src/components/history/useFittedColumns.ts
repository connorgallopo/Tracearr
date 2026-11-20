import { useCallback, useMemo, useState } from 'react';
import {
  NARROW_HIDDEN_COLUMNS,
  getTableMinWidth,
  getVisibleColumns,
  type ColumnVisibility,
  type HistoryColumnId,
} from './historyColumns';
const NO_CHOSEN_COLUMNS: readonly HistoryColumnId[] = [];

/**
 * The columns to show in the element `fitRef` measures. When every wanted column cannot fit
 * beside Content at its minimum, Quality and Progress drop out unless the user chose them.
 * `fits` answers the same question for another set of columns, such as one about to be saved.
 */
export function useFittedColumns(
  columnVisibility: ColumnVisibility,
  {
    isMultiServer = false,
    showProfile = false,
    chosen = NO_CHOSEN_COLUMNS,
  }: { isMultiServer?: boolean; showProfile?: boolean; chosen?: readonly HistoryColumnId[] }
) {
  const [width, setWidth] = useState(0);

  const fitRef = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const fits = useCallback(
    (visibility: ColumnVisibility) =>
      // An element with no layout yet, such as one in a hidden tab, has no width to fit
      width === 0 ||
      getTableMinWidth(getVisibleColumns(visibility, isMultiServer, showProfile)) <= width,
    [width, isMultiServer, showProfile]
  );
  const narrow = !fits(columnVisibility);

  const fitted = useMemo(() => {
    if (!narrow) return columnVisibility;
    const visibility = { ...columnVisibility };
    for (const column of NARROW_HIDDEN_COLUMNS) {
      if (!chosen.includes(column)) visibility[column] = false;
    }
    return visibility;
  }, [narrow, columnVisibility, chosen]);

  return { fitRef, columnVisibility: fitted, fits };
}
