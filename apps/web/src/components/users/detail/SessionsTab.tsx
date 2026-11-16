import { useMemo, useState } from 'react';
import type { ServerUserDetail, Session, SessionWithDetails } from '@tracearr/shared';
import { DataTablePager } from '@/components/ui/data-table';
import { HistoryTable } from '@/components/history/HistoryTable';
import type { ColumnVisibility } from '@/components/history/HistoryFilters';
import { useUserSessions } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { usePagerLabels } from './usePagerLabels';

const PAGE_SIZE = 10;

interface UserSessionsTableProps {
  sessions: Session[];
  user: Pick<ServerUserDetail, 'id' | 'username' | 'thumbUrl'>;
  /** The Tracearr user's name, which the account's own username may not be. */
  personName: string;
  isLoading?: boolean;
  showServer: boolean;
  onSessionClick: (session: SessionWithDetails) => void;
}

/** A person's sessions in the History table; each row keeps its own server since a merged person spans several. */
export function UserSessionsTable({
  sessions,
  user,
  personName,
  isLoading,
  showServer,
  onSessionClick,
}: UserSessionsTableProps) {
  const { servers } = useServer();

  const rows = useMemo<SessionWithDetails[]>(
    () =>
      sessions.map((session) => {
        const server = servers.find((candidate) => candidate.id === session.serverId);
        return {
          ...session,
          user: {
            id: user.id,
            username: user.username,
            thumbUrl: user.thumbUrl,
            identityName: personName,
          },
          server: {
            id: session.serverId,
            name: session.serverName ?? server?.name ?? '',
            type: server?.type ?? 'plex',
          },
        };
      }),
    [sessions, user, personName, servers]
  );

  const columnVisibility = useMemo<ColumnVisibility>(
    () => ({
      date: true,
      user: false,
      content: true,
      server: showServer,
      platform: true,
      location: true,
      ip: false,
      quality: true,
      duration: true,
      progress: true,
    }),
    [showServer]
  );

  return (
    <HistoryTable
      sessions={rows}
      isLoading={isLoading}
      onSessionClick={onSessionClick}
      columnVisibility={columnVisibility}
    />
  );
}

interface SessionsTabProps {
  userId: string;
  scope: 'identity' | undefined;
  user: UserSessionsTableProps['user'];
  personName: string;
  showServer: boolean;
  onSessionClick: (session: SessionWithDetails) => void;
}

export function SessionsTab({
  userId,
  scope,
  user,
  personName,
  showServer,
  onSessionClick,
}: SessionsTabProps) {
  const [page, setPage] = useState(1);
  const { data, isLoading } = useUserSessions(userId, { page, pageSize: PAGE_SIZE, scope });
  const pageCount = Math.ceil((data?.total ?? 0) / PAGE_SIZE);
  const labels = usePagerLabels(page, pageCount);

  return (
    <div className="space-y-4">
      <UserSessionsTable
        sessions={data?.data ?? []}
        user={user}
        personName={personName}
        isLoading={isLoading}
        showServer={showServer}
        onSessionClick={onSessionClick}
      />
      <DataTablePager
        page={page}
        pageCount={pageCount}
        canPrevious={page > 1}
        canNext={page < pageCount}
        onPrevious={() => setPage((current) => Math.max(1, current - 1))}
        onNext={() => setPage((current) => Math.min(pageCount, current + 1))}
        onPage={setPage}
        labels={labels}
      />
    </div>
  );
}
