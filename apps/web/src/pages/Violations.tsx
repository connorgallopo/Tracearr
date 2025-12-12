import { useState } from 'react';
import { Link } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Button } from '@/components/ui/button';
import { SeverityBadge } from '@/components/violations/SeverityBadge';
import { ViolationDetailDialog } from '@/components/violations/ViolationDetailDialog';
import { getAvatarUrl } from '@/components/users/utils';
import { Skeleton } from '@/components/ui/skeleton';
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
import {
  User,
  AlertTriangle,
  Check,
  X,
  Filter,
  MapPin,
  Users,
  Zap,
  Shield,
  Globe,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { ViolationWithDetails, ViolationSeverity } from '@tracearr/shared';
import { useViolations, useAcknowledgeViolation, useDismissViolation } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const ruleIcons: Record<string, React.ReactNode> = {
  impossible_travel: <MapPin className="h-4 w-4" />,
  simultaneous_locations: <Users className="h-4 w-4" />,
  device_velocity: <Zap className="h-4 w-4" />,
  concurrent_streams: <Shield className="h-4 w-4" />,
  geo_restriction: <Globe className="h-4 w-4" />,
};

export function Violations() {
  const [page, setPage] = useState(1);
  const [severityFilter, setSeverityFilter] = useState<ViolationSeverity | 'all'>('all');
  const [acknowledgedFilter, setAcknowledgedFilter] = useState<'all' | 'pending' | 'acknowledged'>('all');
  const [dismissId, setDismissId] = useState<string | null>(null);
  const [selectedViolation, setSelectedViolation] = useState<ViolationWithDetails | null>(null);
  const pageSize = 10;
  const { selectedServerId } = useServer();

  const { data: violationsData, isLoading } = useViolations({
    page,
    pageSize,
    severity: severityFilter === 'all' ? undefined : severityFilter,
    acknowledged:
      acknowledgedFilter === 'all' ? undefined : acknowledgedFilter === 'acknowledged',
    serverId: selectedServerId ?? undefined,
  });
  const acknowledgeViolation = useAcknowledgeViolation();
  const dismissViolation = useDismissViolation();

  const violations = violationsData?.data ?? [];
  const totalPages = violationsData?.totalPages ?? 1;
  const total = violationsData?.total ?? 0;

  const handleAcknowledge = (id: string) => {
    acknowledgeViolation.mutate(id);
  };

  const handleDismiss = (id?: string) => {
    const violationId = id || dismissId;
    if (violationId) {
      dismissViolation.mutate(violationId, {
        onSuccess: () => {
          setDismissId(null);
          setSelectedViolation(null);
        },
      });
    }
  };

  const violationColumns: ColumnDef<ViolationWithDetails>[] = [
    {
      accessorKey: 'user',
      header: 'User',
      cell: ({ row }) => {
        const violation = row.original;
        const avatarUrl = getAvatarUrl(violation.user.serverId, violation.user.thumbUrl, 40);
        return (
          <Link
            to={`/users/${violation.user.id}`}
            className="flex items-center gap-3 hover:underline"
          >
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted">
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt={violation.user.username}
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <User className="h-5 w-5 text-muted-foreground" />
              )}
            </div>
            <span className="font-medium">{violation.user.username}</span>
          </Link>
        );
      },
    },
    {
      accessorKey: 'rule',
      header: 'Rule',
      cell: ({ row }) => {
        const violation = row.original;
        return (
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-muted">
              {ruleIcons[violation.rule.type] ?? <AlertTriangle className="h-4 w-4" />}
            </div>
            <div>
              <p className="font-medium">{violation.rule.name}</p>
              <p className="text-xs text-muted-foreground capitalize">
                {violation.rule.type.replace(/_/g, ' ')}
              </p>
            </div>
          </div>
        );
      },
    },
    {
      accessorKey: 'severity',
      header: 'Severity',
      cell: ({ row }) => <SeverityBadge severity={row.original.severity} />,
    },
    {
      accessorKey: 'createdAt',
      header: 'When',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <span
          className={
            row.original.acknowledgedAt
              ? 'text-muted-foreground'
              : 'text-yellow-500 font-medium'
          }
        >
          {row.original.acknowledgedAt ? 'Acknowledged' : 'Pending'}
        </span>
      ),
    },
    {
      id: 'actions',
      header: '',
      cell: ({ row }) => {
        const violation = row.original;
        return (
          <div className="flex items-center gap-2" onClick={(e) => { e.stopPropagation(); }}>
            {!violation.acknowledgedAt && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAcknowledge(violation.id);
                }}
                disabled={acknowledgeViolation.isPending}
              >
                <Check className="mr-1 h-4 w-4" />
                Acknowledge
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
              Dismiss
            </Button>
          </div>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">Violations</h1>
          <p className="text-muted-foreground">
            {total} violation{total !== 1 ? 's' : ''} total
          </p>
        </div>
      </div>

      {/* Filters */}
      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="flex items-center gap-2 text-base">
            <Filter className="h-4 w-4" />
            Filters
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4">
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Severity</label>
              <Select
                value={severityFilter}
                onValueChange={(value) => {
                  setSeverityFilter(value as ViolationSeverity | 'all');
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Severities</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="warning">Warning</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-muted-foreground">Status</label>
              <Select
                value={acknowledgedFilter}
                onValueChange={(value) => {
                  setAcknowledgedFilter(value as 'all' | 'pending' | 'acknowledged');
                  setPage(1);
                }}
              >
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Statuses</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="acknowledged">Acknowledged</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Violations Table */}
      <Card>
        <CardHeader>
          <CardTitle>Violation Log</CardTitle>
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
              <AlertTriangle className="h-12 w-12 text-muted-foreground" />
              <div className="text-center">
                <h3 className="font-semibold">No violations found</h3>
                <p className="text-sm text-muted-foreground">
                  {severityFilter !== 'all' || acknowledgedFilter !== 'all'
                    ? 'Try adjusting your filters.'
                    : 'No violations have been recorded yet.'}
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
              onRowClick={(violation) => { setSelectedViolation(violation); }}
              emptyMessage="No violations found."
            />
          )}
        </CardContent>
      </Card>

      {/* Violation Detail Dialog */}
      <ViolationDetailDialog
        violation={selectedViolation}
        open={!!selectedViolation}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedViolation(null);
          }
        }}
        onAcknowledge={handleAcknowledge}
        onDismiss={handleDismiss}
        isAcknowledging={acknowledgeViolation.isPending}
        isDismissing={dismissViolation.isPending}
      />

      {/* Dismiss Confirmation Dialog */}
      <Dialog open={!!dismissId} onOpenChange={() => { setDismissId(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Dismiss Violation</DialogTitle>
            <DialogDescription>
              Are you sure you want to dismiss this violation? This will remove it from the
              violation log permanently.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDismissId(null); }}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => handleDismiss()}
              disabled={dismissViolation.isPending}
            >
              {dismissViolation.isPending ? 'Dismissing...' : 'Dismiss'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
