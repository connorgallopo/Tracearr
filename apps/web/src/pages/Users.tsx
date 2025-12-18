import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable } from '@/components/ui/data-table';
import { Input } from '@/components/ui/input';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { User as UserIcon, Crown, Clock, Search } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { ColumnDef } from '@tanstack/react-table';
import type { ServerUserWithIdentity } from '@tracearr/shared';
import { useUsers } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const userColumns: ColumnDef<ServerUserWithIdentity>[] = [
  {
    accessorKey: 'username',
    header: 'User',
    cell: ({ row }) => {
      const user = row.original;
      const avatarUrl = getAvatarUrl(user.serverId, user.thumbUrl, 40);
      return (
        <div className="flex items-center gap-3">
          <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-full">
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={user.username}
                className="h-10 w-10 rounded-full object-cover"
              />
            ) : (
              <UserIcon className="text-muted-foreground h-5 w-5" />
            )}
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-medium">{user.identityName ?? user.username}</span>
              {user.role === 'owner' && (
                <span title="Server Owner">
                  <Crown className="h-4 w-4 text-yellow-500" />
                </span>
              )}
            </div>
            <p className="text-muted-foreground text-xs">@{user.username}</p>
          </div>
        </div>
      );
    },
  },
  {
    accessorKey: 'trustScore',
    header: 'Trust Score',
    cell: ({ row }) => <TrustScoreBadge score={row.original.trustScore} showLabel />,
  },
  {
    accessorKey: 'createdAt',
    header: 'Joined',
    cell: ({ row }) => (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Clock className="h-4 w-4" />
        {formatDistanceToNow(new Date(row.original.createdAt), { addSuffix: true })}
      </div>
    ),
  },
];

export function Users() {
  const navigate = useNavigate();
  const [searchFilter, setSearchFilter] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 100;
  const { selectedServerId } = useServer();

  const { data, isLoading } = useUsers({ page, pageSize, serverId: selectedServerId ?? undefined });

  const users = data?.data ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold">Users</h1>
        <div className="flex items-center gap-4">
          <div className="relative w-64">
            <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
            <Input
              placeholder="Search users..."
              value={searchFilter}
              onChange={(e) => setSearchFilter(e.target.value)}
              className="pl-9"
            />
          </div>
          <p className="text-muted-foreground text-sm">
            {total} user{total !== 1 ? 's' : ''}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="pt-6">
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
          ) : (
            <DataTable
              columns={userColumns}
              data={users}
              pageSize={pageSize}
              pageCount={totalPages}
              page={page}
              onPageChange={setPage}
              filterColumn="username"
              filterValue={searchFilter}
              onRowClick={(user) => {
                void navigate(`/users/${user.id}`);
              }}
              emptyMessage="No users found."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
