/** Stable: the API already lists live servers first, and this keeps that when a page reorders them. */
export function liveFirst<T extends { historicalAt?: string | null }>(servers: T[]): T[] {
  return [...servers].sort((a, b) => Number(!!a.historicalAt) - Number(!!b.historicalAt));
}

type LibrarySetupStatus = {
  isSynced?: boolean;
  needsBackfill?: boolean;
  isBackfillRunning?: boolean;
};

type LibrarySetupStatusEntry = {
  data?: LibrarySetupStatus;
  isLoading?: boolean;
};

/** Missing/undefined keeps the previous always-on catalog-sync behavior. */
export function librarySyncEnabled(server: { librarySyncEnabled?: boolean }): boolean {
  return server.librarySyncEnabled !== false;
}

/**
 * Whether the library UI should nag this server to sync or backfill.
 * Session-only servers (library sync off) are never "unready".
 */
export function serverNeedsLibrarySetup(
  server: { librarySyncEnabled?: boolean },
  status?: LibrarySetupStatus
): boolean {
  if (!librarySyncEnabled(server)) return false;
  if (!status) return false;
  return !status.isSynced || !!status.needsBackfill || !!status.isBackfillRunning;
}

/**
 * True when library pages should render LibraryEmptyState for this selection.
 * Session-only servers never count as "need to sync"; if every selected server
 * is session-only, the empty state still shows so the UI can explain that.
 */
export function allSelectedNeedLibraryEmptyState(
  servers: Array<{ id: string; librarySyncEnabled?: boolean }>,
  statusByServer: Map<string, LibrarySetupStatusEntry>,
  isStatusLoading: boolean
): boolean {
  if (isStatusLoading || servers.length === 0) return false;
  const syncEnabled = servers.filter(librarySyncEnabled);
  if (syncEnabled.length === 0) return true;
  return syncEnabled.every((server) => {
    const entry = statusByServer.get(server.id);
    if (!entry || entry.isLoading) return false;
    return serverNeedsLibrarySetup(server, entry.data);
  });
}
