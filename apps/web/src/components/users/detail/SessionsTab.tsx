import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ProfileFilterOption,
  ServerUserDetail,
  Session,
  SessionWithDetails,
} from '@tracearr/shared';
import { DataTablePager } from '@/components/ui/data-table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProfileOptionLabel } from '@/components/sessions/useProfileLabel';
import { HistoryTable } from '@/components/history/HistoryTable';
import { useFittedColumns } from '@/components/history/useFittedColumns';
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
  /** The profiles that name the rows in a Profile column; none leaves the column out */
  profiles: ProfileFilterOption[];
  onSessionClick: (session: SessionWithDetails) => void;
}

/** A person's sessions in the History table; each row keeps its own server since a merged person spans several. */
export function UserSessionsTable({
  sessions,
  user,
  personName,
  isLoading,
  showServer,
  profiles,
  onSessionClick,
}: UserSessionsTableProps) {
  const { servers } = useServer();
  const profileOptionLabel = useProfileOptionLabel();

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

  const wantedVisibility = useMemo<ColumnVisibility>(
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

  const profileNames = useMemo(
    () =>
      profiles.length > 0
        ? new Map(profiles.map((profile) => [profile.id, profileOptionLabel(profile)]))
        : undefined,
    [profiles, profileOptionLabel]
  );
  const { fitRef, columnVisibility } = useFittedColumns(wantedVisibility, {
    showProfile: profileNames !== undefined,
  });

  return (
    <div ref={fitRef}>
      <HistoryTable
        sessions={rows}
        isLoading={isLoading}
        onSessionClick={onSessionClick}
        columnVisibility={columnVisibility}
        profileNames={profileNames}
      />
    </div>
  );
}

interface SessionsTabProps {
  userId: string;
  scope: 'identity' | undefined;
  user: UserSessionsTableProps['user'];
  personName: string;
  /** The profiles of the accounts in view, or none when none of them is shown */
  profiles: ProfileFilterOption[];
  showServer: boolean;
  onSessionClick: (session: SessionWithDetails) => void;
}

const ALL_PROFILES = 'all';

export function SessionsTab({
  userId,
  scope,
  user,
  personName,
  profiles,
  showServer,
  onSessionClick,
}: SessionsTabProps) {
  const { t } = useTranslation(['pages', 'common']);
  const profileOptionLabel = useProfileOptionLabel();
  const [page, setPage] = useState(1);
  const [profileId, setProfileId] = useState(ALL_PROFILES);
  const { data, isLoading } = useUserSessions(userId, {
    page,
    pageSize: PAGE_SIZE,
    scope,
    profileIds: profileId === ALL_PROFILES ? undefined : [profileId],
  });
  const pageCount = Math.ceil((data?.total ?? 0) / PAGE_SIZE);
  const labels = usePagerLabels(page, pageCount);

  return (
    <div className="space-y-4">
      {profiles.length > 0 && (
        <div className="flex justify-end">
          <Select
            value={profileId}
            onValueChange={(value) => {
              setProfileId(value);
              setPage(1);
            }}
          >
            <SelectTrigger aria-label={t('common:labels.profiles')} className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_PROFILES}>{t('pages:userDetail.allProfiles')}</SelectItem>
              {profiles.map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profileOptionLabel(profile)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      <UserSessionsTable
        sessions={data?.data ?? []}
        user={user}
        personName={personName}
        isLoading={isLoading}
        showServer={showServer}
        profiles={profiles}
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
