import { useState } from 'react';
import { useParams, Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { UserLocationsCard } from '@/components/users/UserLocationsCard';
import { UserDevicesCard } from '@/components/users/UserDevicesCard';
import { EditUserNameDialog } from '@/components/users/EditUserNameDialog';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { ActiveSessionBadge } from '@/components/sessions/ActiveSessionBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  User as UserIcon,
  Crown,
  ArrowLeft,
  Play,
  Clock,
  AlertTriangle,
  Tv,
  Globe,
  XCircle,
  Bot,
  Pencil,
} from 'lucide-react';
import { formatDistanceToNow, format } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type {
  Session,
  ViolationSummary,
  ViolationWithDetails,
  TerminationLogWithDetails,
} from '@tracearr/shared';
import { useUserFull, useUserSessions, useViolations, useUserTerminations } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useAuth } from '@/hooks/useAuth';

/**
 * Format duration in human readable format
 */
function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const sessionColumns: ColumnDef<Session>[] = [
  {
    accessorKey: 'mediaTitle',
    header: 'Media',
    cell: ({ row }) => (
      <div className="max-w-[200px]">
        <p className="truncate font-medium">{row.original.mediaTitle}</p>
        <p className="text-muted-foreground text-xs capitalize">{row.original.mediaType}</p>
      </div>
    ),
  },
  {
    accessorKey: 'state',
    header: 'Status',
    cell: ({ row }) => <ActiveSessionBadge state={row.original.state} />,
  },
  {
    accessorKey: 'durationMs',
    header: 'Duration',
    cell: ({ row }) => <span className="text-sm">{formatDuration(row.original.durationMs)}</span>,
  },
  {
    accessorKey: 'platform',
    header: 'Platform',
    cell: ({ row }) => (
      <div className="flex items-center gap-2 text-sm">
        <Tv className="text-muted-foreground h-4 w-4" />
        <span>{row.original.platform ?? 'Unknown'}</span>
      </div>
    ),
  },
  {
    accessorKey: 'geoCity',
    header: 'Location',
    cell: ({ row }) => {
      const session = row.original;
      if (!session.geoCity && !session.geoCountry) {
        return <span className="text-muted-foreground">—</span>;
      }
      return (
        <div className="flex items-center gap-2 text-sm">
          <Globe className="text-muted-foreground h-4 w-4" />
          <span>
            {session.geoCity && `${session.geoCity}, `}
            {session.geoCountry ?? ''}
          </span>
        </div>
      );
    },
  },
  {
    accessorKey: 'startedAt',
    header: 'Started',
    cell: ({ row }) => (
      <div className="flex items-center gap-2 text-sm">
        <Clock className="text-muted-foreground h-4 w-4" />
        <span>{formatDistanceToNow(new Date(row.original.startedAt), { addSuffix: true })}</span>
      </div>
    ),
  },
];

// Union type for violations - aggregate returns ViolationSummary, paginated returns ViolationWithDetails
type ViolationRow = ViolationSummary | ViolationWithDetails;

const violationColumns: ColumnDef<ViolationRow>[] = [
  {
    accessorKey: 'rule.name',
    header: 'Rule',
    cell: ({ row }) => (
      <div>
        <p className="font-medium">{row.original.rule.name}</p>
        <p className="text-muted-foreground text-xs capitalize">
          {row.original.rule.type.replace(/_/g, ' ')}
        </p>
      </div>
    ),
  },
  {
    accessorKey: 'severity',
    header: 'Severity',
    cell: ({ row }) => (
      <SeverityBadge severity={row.original.severity as 'low' | 'warning' | 'high'} />
    ),
  },
  {
    accessorKey: 'createdAt',
    header: 'When',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">
        {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
      </span>
    ),
  },
  {
    accessorKey: 'acknowledgedAt',
    header: 'Status',
    cell: ({ row }) => (
      <span
        className={
          row.original.acknowledgedAt ? 'text-muted-foreground' : 'font-medium text-yellow-500'
        }
      >
        {row.original.acknowledgedAt ? 'Acknowledged' : 'Pending'}
      </span>
    ),
  },
];

const terminationColumns: ColumnDef<TerminationLogWithDetails>[] = [
  {
    accessorKey: 'trigger',
    header: 'Type',
    cell: ({ row }) => (
      <Badge variant={row.original.trigger === 'manual' ? 'default' : 'secondary'}>
        {row.original.trigger === 'manual' ? (
          <>
            <UserIcon className="mr-1 h-3 w-3" />
            Manual
          </>
        ) : (
          <>
            <Bot className="mr-1 h-3 w-3" />
            Rule
          </>
        )}
      </Badge>
    ),
  },
  {
    accessorKey: 'mediaTitle',
    header: 'Media',
    cell: ({ row }) => (
      <div className="max-w-[200px]">
        <p className="truncate font-medium">{row.original.mediaTitle ?? '—'}</p>
        <p className="text-muted-foreground text-xs capitalize">
          {row.original.mediaType ?? 'unknown'}
        </p>
      </div>
    ),
  },
  {
    accessorKey: 'createdAt',
    header: 'When',
    cell: ({ row }) => (
      <span className="text-muted-foreground text-sm">
        {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
      </span>
    ),
  },
  {
    accessorKey: 'triggeredByUsername',
    header: 'By / Rule',
    cell: ({ row }) => {
      const log = row.original;
      if (log.trigger === 'manual') {
        return <span className="text-sm">@{log.triggeredByUsername ?? 'Unknown'}</span>;
      }
      return (
        <span className="text-muted-foreground text-sm">{log.ruleName ?? 'Unknown rule'}</span>
      );
    },
  },
  {
    accessorKey: 'reason',
    header: 'Reason',
    cell: ({ row }) => (
      <span className="text-muted-foreground block max-w-[150px] truncate text-sm">
        {row.original.reason ?? '—'}
      </span>
    ),
  },
  {
    accessorKey: 'success',
    header: 'Status',
    cell: ({ row }) => (
      <span className={row.original.success ? 'text-green-500' : 'font-medium text-red-500'}>
        {row.original.success ? 'Success' : 'Failed'}
      </span>
    ),
  },
];

export function UserDetail() {
  const { id } = useParams<{ id: string }>();
  const [sessionsPage, setSessionsPage] = useState(1);
  const [violationsPage, setViolationsPage] = useState(1);
  const [terminationsPage, setTerminationsPage] = useState(1);
  const [isEditNameOpen, setIsEditNameOpen] = useState(false);
  const pageSize = 10;
  const { selectedServerId } = useServer();
  const { user: authUser } = useAuth();
  const isOwner = authUser?.role === 'owner';

  // Use the aggregate endpoint for initial load (1 request instead of 6)
  const { data: fullData, isLoading } = useUserFull(id!);

  // Only fetch paginated data when user navigates beyond first page
  const { data: paginatedSessions, isLoading: paginatedSessionsLoading } = useUserSessions(
    id!,
    { page: sessionsPage, pageSize }
    // Only enable when on page > 1 (first page data comes from aggregate)
  );
  const needsPaginatedSessions = sessionsPage > 1;

  const { data: paginatedViolations, isLoading: paginatedViolationsLoading } = useViolations({
    userId: id,
    page: violationsPage,
    pageSize,
    serverId: selectedServerId ?? undefined,
  });
  const needsPaginatedViolations = violationsPage > 1;

  const { data: paginatedTerminations, isLoading: paginatedTerminationsLoading } =
    useUserTerminations(id!, { page: terminationsPage, pageSize });
  const needsPaginatedTerminations = terminationsPage > 1;

  // Extract data from aggregate or paginated sources
  const user = fullData?.user;
  const locations = fullData?.locations ?? [];
  const devices = fullData?.devices ?? [];

  // Sessions: use paginated data if on page > 1, otherwise use aggregate
  const sessions = needsPaginatedSessions
    ? (paginatedSessions?.data ?? [])
    : (fullData?.sessions.data ?? []);
  const sessionsTotal = needsPaginatedSessions
    ? (paginatedSessions?.total ?? fullData?.sessions.total ?? 0)
    : (fullData?.sessions.total ?? 0);
  const sessionsTotalPages = Math.ceil(sessionsTotal / pageSize);
  const sessionsLoading = needsPaginatedSessions ? paginatedSessionsLoading : isLoading;

  // Violations: use paginated data if on page > 1, otherwise use aggregate
  const violations: ViolationRow[] = needsPaginatedViolations
    ? (paginatedViolations?.data ?? [])
    : (fullData?.violations.data ?? []);
  const violationsTotal = needsPaginatedViolations
    ? (paginatedViolations?.total ?? fullData?.violations.total ?? 0)
    : (fullData?.violations.total ?? 0);
  const violationsTotalPages = Math.ceil(violationsTotal / pageSize);
  const violationsLoading = needsPaginatedViolations ? paginatedViolationsLoading : isLoading;

  // Terminations: use paginated data if on page > 1, otherwise use aggregate
  const terminations = needsPaginatedTerminations
    ? (paginatedTerminations?.data ?? [])
    : (fullData?.terminations.data ?? []);
  const terminationsTotal = needsPaginatedTerminations
    ? (paginatedTerminations?.total ?? fullData?.terminations.total ?? 0)
    : (fullData?.terminations.total ?? 0);
  const terminationsTotalPages = Math.ceil(terminationsTotal / pageSize);
  const terminationsLoading = needsPaginatedTerminations ? paginatedTerminationsLoading : isLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardContent className="pt-6">
              <div className="flex items-center gap-4">
                <Skeleton className="h-16 w-16 rounded-full" />
                <div className="space-y-2">
                  <Skeleton className="h-6 w-32" />
                  <Skeleton className="h-4 w-24" />
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <div className="grid grid-cols-2 gap-4">
                {[...Array(4)].map((_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="space-y-6">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back to Users
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">User not found</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link to="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
        </Link>
        <h1 className="text-3xl font-bold">{user.identityName ?? user.username}</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* User Info Card */}
        <Card>
          <CardHeader>
            <CardTitle>User Info</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-start gap-4">
              <div className="bg-muted flex h-16 w-16 items-center justify-center rounded-full">
                {(() => {
                  const avatarUrl = getAvatarUrl(user.serverId, user.thumbUrl, 64);
                  return avatarUrl ? (
                    <img
                      src={avatarUrl}
                      alt={user.username}
                      className="h-16 w-16 rounded-full object-cover"
                    />
                  ) : (
                    <UserIcon className="text-muted-foreground h-8 w-8" />
                  );
                })()}
              </div>
              <div className="flex-1 space-y-2">
                <div className="flex items-center gap-2">
                  <h2 className="text-xl font-semibold">{user.identityName ?? user.username}</h2>
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      onClick={() => setIsEditNameOpen(true)}
                    >
                      <Pencil className="h-4 w-4" />
                    </Button>
                  )}
                  {user.role === 'owner' && (
                    <span title="Server Owner">
                      <Crown className="h-5 w-5 text-yellow-500" />
                    </span>
                  )}
                </div>
                <p className="text-muted-foreground text-sm">@{user.username}</p>
                {user.email && <p className="text-muted-foreground text-sm">{user.email}</p>}
                <div className="flex items-center gap-4 pt-2">
                  <TrustScoreBadge score={user.trustScore} showLabel />
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Card */}
        <Card>
          <CardHeader>
            <CardTitle>Statistics</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Play className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">Sessions</span>
                </div>
                <p className="mt-1 text-2xl font-bold">{user.stats.totalSessions}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">Violations</span>
                </div>
                <p className="mt-1 text-2xl font-bold">{violationsTotal}</p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <Clock className="text-muted-foreground h-4 w-4" />
                  <span className="text-muted-foreground text-sm">Joined</span>
                </div>
                <p className="mt-1 text-sm font-medium">
                  {format(new Date(user.createdAt), 'MMM d, yyyy')}
                </p>
              </div>
              <div className="rounded-lg border p-4">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-sm">Trust Score</span>
                </div>
                <div className="mt-1 flex items-center gap-2">
                  <span className="text-2xl font-bold">{user.trustScore}</span>
                  <span className="text-muted-foreground text-sm">/ 100</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Locations and Devices */}
      <div className="grid gap-6 lg:grid-cols-2">
        <UserLocationsCard
          locations={locations}
          isLoading={isLoading}
          totalSessions={sessionsTotal}
        />
        <UserDevicesCard devices={devices} isLoading={isLoading} totalSessions={sessionsTotal} />
      </div>

      {/* Recent Sessions */}
      <Card>
        <CardHeader>
          <CardTitle>Recent Sessions</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={sessionColumns}
            data={sessions}
            pageSize={pageSize}
            pageCount={sessionsTotalPages}
            page={sessionsPage}
            onPageChange={setSessionsPage}
            isLoading={sessionsLoading}
            emptyMessage="No sessions found for this user."
          />
        </CardContent>
      </Card>

      {/* Violations */}
      <Card>
        <CardHeader>
          <CardTitle>Violations</CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={violationColumns}
            data={violations}
            pageSize={pageSize}
            pageCount={violationsTotalPages}
            page={violationsPage}
            onPageChange={setViolationsPage}
            isLoading={violationsLoading}
            emptyMessage="No violations for this user."
          />
        </CardContent>
      </Card>

      {/* Termination History */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <XCircle className="h-5 w-5" />
            Termination History
          </CardTitle>
        </CardHeader>
        <CardContent>
          <DataTable
            columns={terminationColumns}
            data={terminations}
            pageSize={pageSize}
            pageCount={terminationsTotalPages}
            page={terminationsPage}
            onPageChange={setTerminationsPage}
            isLoading={terminationsLoading}
            emptyMessage="No stream terminations for this user."
          />
        </CardContent>
      </Card>

      {/* Edit Display Name Dialog */}
      <EditUserNameDialog
        open={isEditNameOpen}
        onOpenChange={setIsEditNameOpen}
        userId={id!}
        currentName={user.identityName}
        username={user.username}
      />
    </div>
  );
}
