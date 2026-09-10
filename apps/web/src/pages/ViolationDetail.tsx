import { useState, useMemo, lazy, Suspense } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow, format } from 'date-fns';
import { getFullDateTimeFormatString } from '@/lib/timeFormat';
import type {
  ViolationSessionInfo,
  LocationStats,
  GroupEvidence,
  ConditionEvidence,
} from '@tracearr/shared';
import {
  getViolationDescription,
  getViolationDetails,
  collectViolationSessions,
  formatConditionFieldValue,
  formatUserList,
  type UnitSystem,
} from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableEmpty,
  DataTableHeader,
  DataTablePager,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
} from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { ActionResultsList } from '@/components/violations/ActionResultsList';
import { getAvatarUrl } from '@/components/users/utils';
import { fieldLabel, operatorLabel } from '@/lib/automations';
import { getCountryName, getMediaDisplay } from '@/lib/utils';
import { ServerBadge } from '@/components/server';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import {
  useViolation,
  useAcknowledgeViolation,
  useDismissViolation,
  useSettings,
} from '@/hooks/queries';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  User,
  ArrowLeft,
  AlertTriangle,
  Check,
  X,
  MapPin,
  Clock,
  AlertCircle,
  Film,
  CheckCircle2,
  XCircle,
  Shield,
} from 'lucide-react';

const StreamMap = lazy(() =>
  import('@/components/map/StreamMap').then((m) => ({ default: m.StreamMap }))
);

import { ruleIconsLarge as ruleIcons } from '@/components/violations/ruleIcons';

function ConditionEvidenceRow({
  condition,
  unitSystem,
  userIdToName,
}: {
  condition: ConditionEvidence;
  unitSystem: UnitSystem;
  userIdToName?: Record<string, string>;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const label = fieldLabel(t, condition.field);
  const op = operatorLabel(t, condition.operator);

  const resolveValue = (value: unknown): string => {
    const str = String(value);
    if (condition.field === 'user_id' && userIdToName?.[str]) {
      return userIdToName[str];
    }
    return str;
  };

  const thresholdNum = Number(condition.threshold);
  const thresholdFormatted = formatConditionFieldValue(thresholdNum, condition.field, unitSystem);
  const unitSuffix = thresholdFormatted.unit ? ` ${thresholdFormatted.unit}` : '';
  const thresholdDisplay =
    condition.field === 'user_id' && Array.isArray(condition.threshold)
      ? formatUserList(condition.threshold as string[], userIdToName ?? {})
      : condition.field === 'user_id'
        ? resolveValue(condition.threshold)
        : thresholdFormatted.unit
          ? String(thresholdFormatted.displayValue)
          : String(condition.threshold);

  let actualDisplay: string;
  if (condition.actual !== null && condition.actual !== undefined) {
    if (condition.field === 'user_id') {
      actualDisplay = resolveValue(condition.actual);
    } else {
      const actualNum = Number(condition.actual);
      const actualFormatted = formatConditionFieldValue(actualNum, condition.field, unitSystem);
      actualDisplay = actualFormatted.unit
        ? String(actualFormatted.displayValue)
        : String(condition.actual);
    }
  } else {
    actualDisplay = t('common:labels.unknown').toLowerCase();
  }

  return (
    <div className="flex items-start gap-3 py-2">
      <div className="mt-0.5 shrink-0">
        {condition.matched ? (
          <CheckCircle2 className="h-4 w-4 text-red-500" />
        ) : (
          <XCircle className="text-muted-foreground h-4 w-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-sm font-medium">{label}</span>
          <span className="text-muted-foreground text-xs">
            {op} {thresholdDisplay}
            {unitSuffix}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span
            className={`text-sm ${condition.matched ? 'font-semibold text-red-600' : 'text-muted-foreground'}`}
          >
            {t('violations.detail.actual')}: {actualDisplay}
            {unitSuffix}
          </span>
          {condition.relatedSessionIds && condition.relatedSessionIds.length > 0 && (
            <span className="text-muted-foreground text-xs">
              (
              {t('violations.detail.relatedSessions', {
                count: condition.relatedSessionIds.length,
              })}
              )
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function EvidenceGroupCard({
  group,
  unitSystem,
  userIdToName,
}: {
  group: GroupEvidence;
  unitSystem: UnitSystem;
  userIdToName?: Record<string, string>;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const matchedCount = group.conditions.filter((c) => c.matched).length;
  const totalCount = group.conditions.length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between text-sm">
          <span className="flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {t('violations.detail.conditionGroup', { index: group.groupIndex + 1 })}
          </span>
          <Badge variant={group.matched ? 'destructive' : 'secondary'} className="text-xs">
            {t('violations.detail.matched', { matched: matchedCount, total: totalCount })}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="divide-y">
          {group.conditions.map((condition, idx) => (
            <ConditionEvidenceRow
              key={`${condition.field}-${idx}`}
              condition={condition}
              unitSystem={unitSystem}
              userIdToName={userIdToName}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const sessionColumn = createDataTableColumnHelper<ViolationSessionInfo>();
const getSessionId = (session: ViolationSessionInfo) => session.id;

export function ViolationDetail() {
  const { t } = useTranslation(['pages', 'common']);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [dismissConfirmOpen, setDismissConfirmOpen] = useState(false);

  const { data: violation, isLoading } = useViolation(id!);
  const { data: settings } = useSettings();
  const serverColorMap = useServerColorMap();
  const unitSystem: UnitSystem = settings?.unitSystem ?? 'metric';
  const acknowledgeViolation = useAcknowledgeViolation();
  const dismissViolation = useDismissViolation();

  // Collect all sessions (triggering + related, deduped)
  const allSessions = useMemo(
    () => (violation ? collectViolationSessions(violation) : []),
    [violation]
  );

  // Map sessions to LocationStats for StreamMap
  const mapLocations = useMemo((): LocationStats[] => {
    const locationMap = new Map<string, LocationStats>();

    for (const session of allSessions) {
      if (session.geoLat == null || session.geoLon == null) continue;
      const key = `${session.geoLat},${session.geoLon}`;
      const existing = locationMap.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        locationMap.set(key, {
          city: session.geoCity,
          region: session.geoRegion,
          country: session.geoCountry,
          lat: session.geoLat,
          lon: session.geoLon,
          count: 1,
        });
      }
    }

    return Array.from(locationMap.values());
  }, [allSessions]);

  const hasGeoData = mapLocations.length > 0;

  // Session table columns
  const sessionColumns = useMemo(
    () =>
      sessionColumn.columns([
        sessionColumn.accessor('mediaTitle', {
          header: t('common:labels.media'),
          cell: ({ row }) => {
            const session = row.original;
            const { title, subtitle } = getMediaDisplay(session);
            const isTriggering = violation?.session?.id === session.id;
            return (
              <div className="flex items-center gap-2">
                <div className="max-w-[200px]">
                  <p className="truncate font-medium">{title}</p>
                  {subtitle ? (
                    <p className="text-muted-foreground text-xs">{subtitle}</p>
                  ) : (
                    <p className="text-muted-foreground text-xs capitalize">{session.mediaType}</p>
                  )}
                </div>
                {isTriggering && (
                  <Badge
                    variant="outline"
                    className="text-primary border-primary/50 shrink-0 text-xs"
                  >
                    {t('pages:violations.detail.trigger')}
                  </Badge>
                )}
              </div>
            );
          },
        }),
        sessionColumn.accessor('ipAddress', {
          header: t('common:labels.ipAddress'),
          cell: ({ row }) => <span className="font-mono text-sm">{row.original.ipAddress}</span>,
        }),
        sessionColumn.accessor('geoCity', {
          header: t('common:labels.location'),
          cell: ({ row }) => {
            const session = row.original;
            if (!session.geoCity && !session.geoCountry) {
              return <span className="text-muted-foreground">—</span>;
            }
            return (
              <span className="text-sm">
                {session.geoCity && `${session.geoCity}, `}
                {getCountryName(session.geoCountry) ?? ''}
              </span>
            );
          },
        }),
        sessionColumn.accessor('device', {
          header: t('common:labels.device'),
          cell: ({ row }) => {
            const session = row.original;
            return (
              <div className="text-sm">
                <p>{session.device || session.platform || t('common:labels.unknown')}</p>
                {session.playerName && (
                  <p className="text-muted-foreground text-xs">{session.playerName}</p>
                )}
              </div>
            );
          },
        }),
        sessionColumn.accessor('quality', {
          header: t('common:labels.quality'),
          cell: ({ row }) => <span className="text-sm">{row.original.quality ?? '—'}</span>,
        }),
        sessionColumn.accessor('startedAt', {
          header: t('common:labels.started'),
          cell: ({ row }) => (
            <span className="text-muted-foreground text-sm">
              {formatDistanceToNow(new Date(row.original.startedAt), { addSuffix: true })}
            </span>
          ),
        }),
      ]),
    [t, violation?.session?.id]
  );

  const { table: sessionsTable, pager: sessionsPager } = useDataTable<ViolationSessionInfo>({
    columns: sessionColumns,
    data: allSessions,
    getRowId: getSessionId,
  });

  const handleAcknowledge = () => {
    if (!violation) return;
    acknowledgeViolation.mutate(violation.id);
  };

  const handleDismiss = () => {
    if (!violation) return;
    dismissViolation.mutate(violation.id, {
      onSuccess: () => {
        setDismissConfirmOpen(false);
        void navigate('/violations');
      },
    });
  };

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-8 w-48" />
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <Skeleton className="h-48" />
          </div>
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!violation) {
    return (
      <div className="space-y-6">
        <Link to="/violations">
          <Button variant="ghost" size="sm">
            <ArrowLeft />
            {t('common:actions.back')}
          </Button>
        </Link>
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">{t('pages:violations.detail.notFound')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const userDisplayName = violation.user.identityName ?? violation.user.username;

  const userIdToName: Record<string, string> = {
    ...(violation.userNames ?? {}),
    [violation.user.id]: userDisplayName,
  };

  const rawDescription = getViolationDescription(violation, unitSystem);
  const description = rawDescription.split(violation.user.id).join(userDisplayName);

  const rawDetails = getViolationDetails(violation, unitSystem);
  const details = Object.fromEntries(
    Object.entries(rawDetails).map(([key, value]) => {
      if (typeof value === 'string' && value === violation.user.id) {
        return [key, userDisplayName];
      }
      return [key, value];
    })
  );

  const isPending = !violation.acknowledgedAt;
  const ruleIcon = (violation.rule.type && ruleIcons[violation.rule.type]) ?? (
    <AlertTriangle className="h-5 w-5" />
  );
  const avatarUrl = getAvatarUrl(violation.user.serverId, violation.user.thumbUrl, 80);
  const isInactivity = violation.rule.type === 'account_inactivity';

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-4">
          <Link to="/violations">
            <Button variant="ghost" size="sm">
              <ArrowLeft />
              {t('common:actions.back')}
            </Button>
          </Link>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
              {ruleIcon}
            </div>
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-2xl font-bold">{violation.rule.name}</h1>
                <SeverityBadge severity={violation.severity} />
              </div>
              <p className="text-muted-foreground text-sm">{description}</p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isPending && (
            <Button onClick={handleAcknowledge} disabled={acknowledgeViolation.isPending}>
              <Check />
              {acknowledgeViolation.isPending
                ? t('common:states.acknowledging')
                : t('common:actions.acknowledge')}
            </Button>
          )}
          <Button variant="destructive" onClick={() => setDismissConfirmOpen(true)}>
            <X />
            {t('common:actions.dismiss')}
          </Button>
        </div>
      </div>

      {/* Timestamps row */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5">
          <Clock className="h-4 w-4" />
          {t('pages:violations.detail.detected')}{' '}
          {formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true })}
        </span>
        {violation.acknowledgedAt && (
          <>
            <span>·</span>
            <span className="flex items-center gap-1.5">
              <Check className="h-4 w-4 text-green-600" />
              {t('common:states.acknowledged')}{' '}
              {formatDistanceToNow(new Date(violation.acknowledgedAt), { addSuffix: true })}
            </span>
          </>
        )}
      </div>

      {/* Top row: Violation Details + User Info */}
      <div className="grid gap-6 lg:grid-cols-3">
        {/* Violation Details */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t('pages:violations.detail.violationDetails')}</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(details).length > 0 ? (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
                {Object.entries(details).map(([key, value]) => {
                  if (Array.isArray(value)) {
                    return (
                      <div key={key} className="col-span-full">
                        <p className="text-muted-foreground mb-1 text-xs">{key}</p>
                        <div className="flex flex-wrap gap-1">
                          {value.map((item, idx) => (
                            <span
                              key={idx}
                              className="bg-muted inline-flex items-center rounded-md px-2 py-1 text-xs font-medium"
                            >
                              {String(item)}
                            </span>
                          ))}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={key}>
                      <p className="text-muted-foreground mb-1 text-xs">{key}</p>
                      <p className="text-sm font-medium">{String(value)}</p>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">{description}</p>
            )}
          </CardContent>
        </Card>

        {/* User Info */}
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:violations.detail.userInfo')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Link to={`/users/${violation.user.id}`} className="group flex items-center gap-4">
              <div className="bg-muted flex h-14 w-14 shrink-0 items-center justify-center rounded-full">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={violation.user.identityName ?? violation.user.username}
                    className="h-14 w-14 rounded-full object-cover"
                  />
                ) : (
                  <User className="text-muted-foreground h-7 w-7" />
                )}
              </div>
              <div className="min-w-0">
                <p className="truncate font-semibold group-hover:underline">
                  {violation.user.identityName ?? violation.user.username}
                </p>
                <p className="text-muted-foreground truncate text-sm">@{violation.user.username}</p>
                {violation.server && (
                  <ServerBadge
                    server={{
                      ...violation.server,
                      color: serverColorMap.get(violation.server.id) ?? null,
                    }}
                    variant="outlined"
                    className="mt-1"
                  />
                )}
              </div>
            </Link>
          </CardContent>
        </Card>
      </div>

      {/* Condition Evidence (V2 violations) */}
      {violation.evidence && violation.evidence.length > 0 && (
        <div className="space-y-4">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Shield className="h-5 w-5" />
            {t('violations.detail.conditionEvidence')}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {violation.evidence.map((group) => (
              <EvidenceGroupCard
                key={group.groupIndex}
                group={group}
                unitSystem={unitSystem}
                userIdToName={userIdToName}
              />
            ))}
          </div>
        </div>
      )}

      {/* Sessions Table */}
      {allSessions.length > 0 && !isInactivity && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Film className="h-5 w-5" />
              {t('pages:violations.detail.sessions')}
              <Badge variant="secondary" className="ml-1">
                {allSessions.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <DataTableRoot>
              <DataTableViewport flush>
                <DataTableHeader table={sessionsTable} />
                <DataTableBody
                  table={sessionsTable}
                  empty={
                    <DataTableEmpty
                      table={sessionsTable}
                      title={t('pages:violations.detail.noSessions')}
                    />
                  }
                />
              </DataTableViewport>
              <DataTablePager
                {...sessionsPager}
                labels={{
                  navigation: t('common:table.pagination'),
                  status: t('common:table.pageOf', {
                    page: sessionsPager.page,
                    total: sessionsPager.pageCount,
                  }),
                  previous: t('common:actions.previous'),
                  next: t('common:actions.next'),
                }}
              />
            </DataTableRoot>
          </CardContent>
        </Card>
      )}

      {/* Map */}
      {hasGeoData && !isInactivity && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              {t('pages:violations.detail.map')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[400px] overflow-hidden rounded-lg">
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Skeleton className="h-full w-full" />
                  </div>
                }
              >
                <StreamMap locations={mapLocations} viewMode="circles" />
              </Suspense>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Account Inactivity Details */}
      {isInactivity && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5" />
              {t('pages:violations.detail.inactivity')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
              <div>
                <p className="text-muted-foreground mb-1 text-xs">
                  {t('pages:violations.detail.daysInactive')}
                </p>
                <p className="text-3xl font-bold">
                  {(violation.data.inactiveDays as number) ?? 'N/A'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground mb-1 text-xs">
                  {t('pages:violations.detail.threshold')}
                </p>
                <p className="text-3xl font-bold">
                  {(violation.data.thresholdDays as number) ?? 'N/A'}
                  <span className="text-muted-foreground ml-1 text-sm font-normal">
                    {t('common:labels.days')}
                  </span>
                </p>
              </div>
              <div className="col-span-2 sm:col-span-1">
                <p className="text-muted-foreground mb-1 text-xs">
                  {t('pages:violations.detail.lastActivity')}
                </p>
                {violation.data.neverActive ? (
                  <p className="flex items-center gap-1 font-medium text-yellow-600">
                    <AlertCircle className="h-4 w-4" />
                    {t('pages:violations.detail.neverActive')}
                  </p>
                ) : violation.data.lastActivityAt ? (
                  <div>
                    <p className="font-medium">
                      {format(
                        new Date(violation.data.lastActivityAt as string),
                        getFullDateTimeFormatString()
                      )}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {formatDistanceToNow(new Date(violation.data.lastActivityAt as string), {
                        addSuffix: true,
                      })}
                    </p>
                  </div>
                ) : (
                  <p className="text-muted-foreground">{t('common:labels.unknown')}</p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Results */}
      {violation.actionResults && violation.actionResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t('pages:violations.detail.actions')}</CardTitle>
          </CardHeader>
          <CardContent>
            <ActionResultsList results={violation.actionResults} />
          </CardContent>
        </Card>
      )}

      {/* Timestamps */}
      <Card>
        <CardHeader>
          <CardTitle>{t('pages:violations.detail.timestamps')}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground mb-1 text-xs">
                {t('pages:violations.detail.created')}
              </p>
              <p className="text-sm font-medium">
                {format(new Date(violation.createdAt), getFullDateTimeFormatString())}
              </p>
              <p className="text-muted-foreground text-xs">
                {formatDistanceToNow(new Date(violation.createdAt), { addSuffix: true })}
              </p>
            </div>
            {violation.acknowledgedAt && (
              <div>
                <p className="text-muted-foreground mb-1 text-xs">
                  {t('pages:violations.detail.acknowledged')}
                </p>
                <p className="text-sm font-medium">
                  {format(new Date(violation.acknowledgedAt), getFullDateTimeFormatString())}
                </p>
                <p className="text-muted-foreground text-xs">
                  {formatDistanceToNow(new Date(violation.acknowledgedAt), { addSuffix: true })}
                </p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Dismiss Confirmation Dialog */}
      <Dialog open={dismissConfirmOpen} onOpenChange={setDismissConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages:violations.dismissViolation')}</DialogTitle>
            <DialogDescription>{t('pages:violations.dismissViolationConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDismissConfirmOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleDismiss}
              disabled={dismissViolation.isPending}
            >
              {dismissViolation.isPending
                ? t('common:states.dismissing')
                : t('common:actions.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
