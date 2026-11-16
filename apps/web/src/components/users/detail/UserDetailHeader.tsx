import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Crown, Eye, Loader2, Pencil } from 'lucide-react';
import type { ServerUserFullDetail } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TimeRangePicker, type TimeRangeValue } from '@/components/ui/time-range-picker';
import { ServerColumnCell } from '@/components/server';
import { ContactEmailLine } from '@/components/users/ContactEmailLine';
import { RemovedBadge } from '@/components/users/RemovedBadge';
import { TrustScoreBadge } from '@/components/users/TrustScoreBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { useViewAs } from '@/hooks/queries/useImpersonation';
import { cn } from '@/lib/utils';
import { formatDate } from '@/lib/dateFormat';
import { ROLE_LABEL_KEYS } from '@/components/users/roleLabels';

interface UserDetailHeaderProps {
  detail: ServerUserFullDetail;
  isOwner: boolean;
  scopeParam: string | null;
  onScopeChange: (value: string) => void;
  isSpecificServerScope: boolean;
  removed: { removed: true; removedAt: Date | string } | { removed: false };
  timeRange: TimeRangeValue;
  onTimeRangeChange: (value: TimeRangeValue) => void;
  onEditIdentity: () => void;
  onAdjustTrust: () => void;
}

export function UserDetailHeader({
  detail,
  isOwner,
  scopeParam,
  onScopeChange,
  isSpecificServerScope,
  removed,
  timeRange,
  onTimeRangeChange,
  onEditIdentity,
  onAdjustTrust,
}: UserDetailHeaderProps) {
  const { t } = useTranslation(['pages', 'common', 'nav']);
  const viewAs = useViewAs();
  const { user, identity } = detail;
  const name = user.identityName ?? identity.username;
  const isMerged = identity.serverUsers.length > 1;
  const showsPerson = isMerged && !isSpecificServerScope;
  const avatarUrl = getAvatarUrl(user.serverId, user.thumbUrl, 64);
  const canViewAs =
    isOwner && user.role !== 'owner' && user.role !== 'disabled' && user.role !== 'pending';
  const servers = isSpecificServerScope
    ? [{ id: user.serverId, name: user.serverName }]
    : identity.serverUsers.map((account) => ({ id: account.serverId, name: account.serverName }));

  return (
    <header className="space-y-4">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/users">{t('nav:users')}</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{name}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>

      <div className="flex flex-wrap items-start gap-4">
        <Avatar aria-hidden className="size-16">
          {avatarUrl !== null && <AvatarImage src={avatarUrl} alt="" />}
          <AvatarFallback className="text-xl font-medium">
            {name.slice(0, 1).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className={cn(
                'text-2xl font-bold',
                removed.removed && 'text-muted-foreground line-through'
              )}
            >
              {name}
            </h1>
            {isOwner && (
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('pages:userDetail.editIdentity')}
                onClick={onEditIdentity}
              >
                <Pencil />
              </Button>
            )}
            <TrustScoreBadge
              score={showsPerson ? identity.aggregateTrustScore : user.trustScore}
              showLabel
            />
            {user.role === 'owner' && (
              <span title={t('common:labels.serverOwner')}>
                <Crown className="text-foreground h-5 w-5" />
              </span>
            )}
            {removed.removed && <RemovedBadge removedAt={removed.removedAt} />}
          </div>
          <div
            data-testid="user-facts"
            className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-sm"
          >
            {user.email && <span>{user.email} ·</span>}
            <span>{t(ROLE_LABEL_KEYS[user.role])}</span>
            <span>
              · {t('common:labels.joined')}{' '}
              {formatDate(new Date(user.joinedAt ?? user.createdAt), { dateStyle: 'medium' })}
            </span>
            <span>·</span>
            {servers.map((server) => (
              <ServerColumnCell key={server.id} server={server} />
            ))}
          </div>
          <ContactEmailLine
            contactEmail={identity.contactEmail}
            isOwner={isOwner}
            onEdit={onEditIdentity}
          />
          {viewAs.error && <FieldError>{viewAs.error.message}</FieldError>}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {isMerged && (
            <Select value={scopeParam ?? 'all'} onValueChange={onScopeChange}>
              <SelectTrigger aria-label={t('pages:userDetail.serverScope')} className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('pages:userDetail.allServers')}</SelectItem>
                {identity.serverUsers.map((account) => (
                  <SelectItem key={account.id} value={account.id} textValue={account.serverName}>
                    <span className="flex items-center gap-2">
                      {account.serverName}
                      {account.removedAt && <RemovedBadge removedAt={account.removedAt} />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <TimeRangePicker value={timeRange} onChange={onTimeRangeChange} />
          {isOwner && !showsPerson && (
            <Button variant="outline" size="sm" onClick={onAdjustTrust}>
              <Pencil />
              {t('pages:userDetail.adjustTrustScore')}
            </Button>
          )}
          {canViewAs && (
            <Button
              variant="outline"
              size="sm"
              disabled={viewAs.isPending}
              aria-label={t('pages:userDetail.access.viewAsLabel', { name })}
              title={t('pages:userDetail.access.viewAsHint')}
              onClick={() => viewAs.mutate(user.userId)}
            >
              {viewAs.isPending ? <Loader2 className="animate-spin" /> : <Eye />}
              {t('pages:userDetail.access.viewAs')}
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}
