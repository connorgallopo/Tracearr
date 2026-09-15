import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RequestsSummary } from '@/components/requests/RequestsSummary';
import { RequestsTable } from '@/components/requests/RequestsTable';
import { useUserRequests } from '@/hooks/queries/useRequests';

const INITIAL_PAGE_SIZE = 5;
const EXPANDED_PAGE_SIZE = 50;

interface UserRequestsCardProps {
  serverUserId: string;
  scope: 'identity' | undefined;
}

export function UserRequestsCard({ serverUserId, scope }: UserRequestsCardProps) {
  const { t } = useTranslation('pages');
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, isError, refetch } = useUserRequests(serverUserId, {
    scope,
    page: 1,
    pageSize: expanded ? EXPANDED_PAGE_SIZE : INITIAL_PAGE_SIZE,
  });

  if (isLoading || (data && data.total === 0)) return null;

  const remaining = Math.min(data?.total ?? 0, EXPANDED_PAGE_SIZE) - INITIAL_PAGE_SIZE;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('requests.userCard.title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {data && <RequestsSummary summary={data.summary} />}

        <RequestsTable
          subject="user"
          rows={data?.data ?? []}
          isLoading={isLoading}
          isError={isError}
          onRetry={() => void refetch()}
          emptyTitle={t('requests.userCard.empty')}
        />

        {remaining > 0 && (
          <Button
            variant="ghost"
            size="sm"
            className="w-full"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? (
              <>
                <ChevronUp className="mr-2 h-4 w-4" />
                {t('requests.userCard.showLess')}
              </>
            ) : (
              <>
                <ChevronDown className="mr-2 h-4 w-4" />
                {t('requests.userCard.viewAll', { count: remaining })}
              </>
            )}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
