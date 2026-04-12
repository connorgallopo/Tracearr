import { useState, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable, type SortingState } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { User, AlertTriangle, Check, X, Filter, Trash2 } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { ViolationWithDetails, ViolationSeverity, ViolationSortField } from '@tracearr/shared';
import {
  useViolations,
  useRules,
  useAcknowledgeViolation,
  useDismissViolation,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useRowSelection } from '@/hooks/useRowSelection';

import { ruleIcons } from '@/components/violations/ruleIcons';

// Map DataTable column IDs to API sort field names
const columnToSortField: Record<string, ViolationSortField> = {
  createdAt: 'createdAt',
  severity: 'severity',
  user: 'user',
  rule: 'rule',
};

export function Violations() {
  const { t } = useTranslation(['pages', 'common']);
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [sorting, setSorting] = useState<SortingState>([{ id: 'createdAt', desc: true }]);
  const [severityFilter, setSeverityFilter] = useState<ViolationSeverity | 'all'>('all');
  const [ruleFilter, setRuleFilter] = useState<string>('all');
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<'all' | 'pending' | 'acknowledged'>(
    'all'
  );
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [bulkDismissConfirmOpen, setBulkDismissConfirmOpen] = useState(false);
  const pageSize = 10;
  const { selectedServerId } = useServer();
  const { data: rules = [] } = useRules();

  // Convert sorting state to API params
  const orderBy = sorting[0]?.id ? columnToSortField[sorting[0].id] : undefined;
  const orderDir = sorting[0] ? (sorting[0].desc ? 'desc' : 'asc') : undefined;

  const { data: violationsData, isLoading } = useViolations({
    page,
    pageSize,
    ruleId: ruleFilter === 'all' ? undefined : ruleFilter,
    severity: severityFilter === 'all' ? undefined : severityFilter,
    acknowledged: acknowledgedFilter === 'all' ? undefined : acknowledgedFilter === 'acknowledged',
    serverId: selectedServerId ?? undefined,
    orderBy,
    orderDir,
  });
  const acknowledgeViolation = useAcknowledgeViolation();
  const dismissViolation = useDismissViolation();
  const bulkAcknowledge = useBulkAcknowledgeViolations();
  const bulkDismiss = useBulkDismissViolations();

  const violations = violationsData?.data ?? [];
  const totalPages = violationsData?.totalPages ?? 1;
  const total = violationsData?.total ?? 0;

  // Row selection
  const {
    selectedIds,
    selectAllMode,
    selectedCount,
    isSelected: _isSelected,
    toggleRow,
    togglePage,
    selectAll,
    clearSelection,
    isPageSelected,
    isPageIndeterminate,
  } = useRowSelection({
    getRowId: (row: ViolationWithDetails) => row.id,
    totalCount: total,
  });

  // Current filter params for bulk operations
  const currentFilters = useMemo(
    () => ({
      serverId: selectedServerId ?? undefined,
      severity: severityFilter === 'all' ? undefined : severityFilter,
      acknowledged:
        acknowledgedFilter === 'all' ? undefined : acknowledgedFilter === 'acknowledged',
    }),
    [selectedServerId, severityFilter, acknowledgedFilter]
  );

  const handleAcknowledge = (id: string) => {
    acknowledgeViolation.mutate(id);
  };

  const handleDismiss = (id?: string) => {
    const violationId = id || dismissId;
    if (violationId) {
      dismissViolation.mutate(violationId, {
        onSuccess: () => {
          setDismissId(null);
        },
      });
    }
  };

  const handleBulkAcknowledge = () => {
    if (selectAllMode) {
      bulkAcknowledge.mutate(
        { selectAll: true, filters: currentFilters },
        { onSuccess: clearSelection }
      );
    } else {
      bulkAcknowledge.mutate({ ids: Array.from(selectedIds) }, { onSuccess: clearSelection });
    }
  };

  const handleBulkDismiss = () => {
    if (selectAllMode) {
      bulkDismiss.mutate(
        { selectAll: true, filters: currentFilters },
        {
          onSuccess: () => {
            clearSelection();
            setBulkDismissConfirmOpen(false);
          },
        }
      );
    } else {
      bulkDismiss.mutate(
        { ids: Array.from(selectedIds) },
        {
          onSuccess: () => {
            clearSelection();
            setBulkDismissConfirmOpen(false);
          },
        }
      );
    }
  };

  const handleSortingChange = useCallback((newSorting: SortingState) => {
    setSorting(newSorting);
    setPage(1);
  }, []);

  const bulkActions: BulkAction[] = [
    {
      key: 'acknowledge',
      label: t('common:actions.acknowledge'),
      icon: <Check className="h-4 w-4" />,
      variant: 'default',
      onClick: handleBulkAcknowledge,
      isLoading: bulkAcknowledge.isPending,
    },
    {
      key: 'dismiss',
      label: t('common:actions.dismiss'),
      icon: <Trash2 className="h-4 w-4" />,
      variant: 'destructive',
      onClick: () => setBulkDismissConfirmOpen(true),
      isLoading: bulkDismiss.isPending,
    },
  ];

  const violationColumns: ColumnDef<ViolationWithDetails>[] = useMemo(
    () => [
      {
        accessorKey: 'user',
        header: t('common:labels.user'),
        cell: ({ row }) => {
          const violation = row.original;
          const avatarUrl = getAvatarUrl(violation.user.serverId, violation.user.thumbUrl, 40);
          return (
            <Link
              to={`/users/${violation.user.id}`}
              className="flex items-center gap-3 hover:underline"
            >
              <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
                {avatarUrl ? (
                  <img
                    src={avatarUrl}
                    alt={violation.user.username}
                    className="h-10 w-10 rounded-full object-cover"
                  />
                ) : (
                  <User className="text-muted-foreground h-5 w-5" />
                )}
              </div>
              <span className="font-medium">
                {violation.user.identityName ?? violation.user.username}
              </span>
            </Link>
          );
        },
      },
      {
        accessorKey: 'rule',
        header: t('common:labels.rule'),
        cell: ({ row }) => {
          const violation = row.original;
          return (
            <div className="flex items-center gap-2">
              <div className="bg-muted flex h-8 w-8 items-center justify-center rounded">
                {(violation.rule.type && ruleIcons[violation.rule.type]) ?? (
                  <AlertTriangle className="h-4 w-4" />
                )}
              </div>
              <div>
                <p className="font-medium">{violation.rule.name}</p>
                <p className="text-muted-foreground text-xs capitalize">
                  {violation.rule.type?.replace(/_/g, ' ') ?? 'Custom Rule'}
                </p>
              </div>
            </div>
          );
        },
      },
      {
        accessorKey: 'severity',
        header: t('common:labels.severity'),
        cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
      },
      {
        accessorKey: 'createdAt',
        header: t('common:labels.when'),
        cell: ({ row }) => (
          <span className="text-muted-foreground text-sm">
            {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
          </span>
        ),
      },
      {
        accessorKey: 'status',
        header: t('common:labels.status'),
        cell: ({ row }) => (
          <span
            className={
              row.original.acknowledgedAt ? 'text-muted-foreground' : 'font-medium text-yellow-500'
            }
          >
            {row.original.acknowledgedAt
              ? t('common:states.acknowledged')
              : t('common:states.pending')}
          </span>
        ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const violation = row.original;
          return (
            <div
              className="flex items-center gap-2"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              {!violation.acknowledgedAt && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAcknowledge(violation.id);
                  }}
                  disabled={acknowledgeViolation.isPending}
                  className="text-green-600 hover:text-green-700 dark:text-green-500 dark:hover:text-green-400"
                >
                  <Check className="mr-1 h-4 w-4" />
                  {t('common:actions.acknowledge')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  setDismissId(violation.id);
                }}
                className="text-destructive hover:text-destructive"
              >
                <X className="mr-1 h-4 w-4" />
                {t('common:actions.dismiss')}
              </Button>
            </div>
          );
        },
      },
    ],
    [t, handleAcknowledge, acknowledgeViolation.isPending]
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('violations.title')}</h1>
          <p className="text-muted-foreground">{t('common:count.violation', { count: total })}</p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" />
            {t('common:labels.filters')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-2">
              <label className="text-muted-foreground text-sm">{t('common:labels.rule')}</label>
              <Select
                value={ruleFilter}
                onValueChange={(value) => {
                  setRuleFilter(value);
                  setPage(1);
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pages:violations.allRules')}</SelectItem>
                  {rules.map((rule) => (
                    <SelectItem key={rule.id} value={rule.id}>
                      {rule.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-muted-foreground text-sm">{t('common:labels.severity')}</label>
              <Select
                value={severityFilter}
                onValueChange={(value) => {
                  setSeverityFilter(value as ViolationSeverity | 'all');
                  setPage(1);
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pages:violations.allSeverities')}</SelectItem>
                  <SelectItem value="high">{t('common:severity.high')}</SelectItem>
                  <SelectItem value="warning">{t('common:severity.warning')}</SelectItem>
                  <SelectItem value="low">{t('common:severity.low')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-muted-foreground text-sm">{t('common:labels.status')}</label>
              <Select
                value={acknowledgedFilter}
                onValueChange={(value) => {
                  setAcknowledgedFilter(value as 'all' | 'pending' | 'acknowledged');
                  setPage(1);
                  clearSelection();
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('pages:violations.allStatuses')}</SelectItem>
                  <SelectItem value="pending">{t('common:states.pending')}</SelectItem>
                  <SelectItem value="acknowledged">{t('common:states.acknowledged')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Violations Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t('violations.violationLog')}</CardTitle>
          {ruleFilter === 'all' && selectedCount > 0 && !selectAllMode && total > selectedCount && (
            <Button variant="link" size="sm" onClick={selectAll} className="text-sm">
              {t('violations.selectAllViolations', { count: total })}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-4">
              {[...Array(5)].map((_, i) => (
                <div key={i} className="flex items-center gap-4">
                  <Skeleton className="h-10 w-10 rounded-full" />
                  <div className="space-y-2">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-24" />
                  </div>
                </div>
              ))}
            </div>
          ) : violations.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center gap-4">
              <AlertTriangle className="text-muted-foreground h-12 w-12" />
              <div className="text-center">
                <h3 className="font-semibold">{t('violations.noViolationsFound')}</h3>
                <p className="text-muted-foreground text-sm">
                  {ruleFilter !== 'all' || severityFilter !== 'all' || acknowledgedFilter !== 'all'
                    ? t('violations.tryAdjustingFilters')
                    : t('violations.noViolationsRecorded')}
                </p>
              </div>
            </div>
          ) : (
            <DataTable
              columns={violationColumns}
              data={violations}
              pageSize={pageSize}
              pageCount={totalPages}
              page={page}
              onPageChange={setPage}
              sorting={sorting}
              onSortingChange={handleSortingChange}
              isServerFiltered
              onRowClick={(violation) => {
                void navigate(`/violations/${violation.id}`);
              }}
              emptyMessage={t('violations.noViolationsFound')}
              selectable
              getRowId={(row) => row.id}
              selectedIds={selectedIds}
              selectAllMode={selectAllMode}
              onRowSelect={toggleRow}
              onPageSelect={togglePage}
              isPageSelected={isPageSelected(violations)}
              isPageIndeterminate={isPageIndeterminate(violations)}
            />
          )}
        </CardContent>
      </Card>

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        selectAllMode={selectAllMode}
        totalCount={total}
        actions={bulkActions}
        onClearSelection={clearSelection}
      />

      {/* Dismiss Confirmation Dialog */}
      <Dialog
        open={!!dismissId}
        onOpenChange={() => {
          setDismissId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('pages:violations.dismissViolation')}</DialogTitle>
            <DialogDescription>{t('pages:violations.dismissViolationConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDismissId(null);
              }}
            >
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleDismiss()}
              disabled={dismissViolation.isPending}
            >
              {dismissViolation.isPending
                ? t('common:states.dismissing')
                : t('common:actions.dismiss')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk Dismiss Confirmation Dialog */}
      <Dialog open={bulkDismissConfirmOpen} onOpenChange={setBulkDismissConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('pages:violations.dismissViolation', {
                count: selectAllMode ? total : selectedCount,
              })}
            </DialogTitle>
            <DialogDescription>{t('pages:violations.dismissViolationsConfirm')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDismissConfirmOpen(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDismiss}
              disabled={bulkDismiss.isPending}
            >
              {bulkDismiss.isPending
                ? t('common:states.dismissing')
                : t('pages:violations.dismissViolation', {
                    count: selectAllMode ? total : selectedCount,
                  })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
