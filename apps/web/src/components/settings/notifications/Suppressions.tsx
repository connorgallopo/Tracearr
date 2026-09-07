import { useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ExternalLink, MailX, Plus, Trash2 } from 'lucide-react';
import { emailSuppressionCreateSchema, type EmailSuppression } from '@tracearr/shared';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { dateLabel } from '@/components/settings/shared/dateLabel';
import { useAddSuppression, useEmailSuppressions, useRemoveSuppression } from '@/hooks/queries';
import { NEWSLETTERS_PATH } from './Newsletters';

export function Suppressions() {
  const { t } = useTranslation(['settings', 'common']);
  const { data, isLoading, isError, error } = useEmailSuppressions();
  const add = useAddSuppression();
  const remove = useRemoveSuppression();
  const [adding, setAdding] = useState(false);
  const [address, setAddress] = useState('');
  const [removing, setRemoving] = useState<EmailSuppression | null>(null);
  const parsed = emailSuppressionCreateSchema.safeParse({ address });
  const isEmpty = data !== undefined && data.length === 0;

  const addButton = (
    <Button variant="outline" onClick={() => setAdding(true)}>
      <Plus />
      {t('email.suppressions.add')}
    </Button>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('email.suppressions.title')}</CardTitle>
        <CardDescription>{t('email.suppressions.globalNote')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-24 w-full" />}
        {isError && (
          <Alert variant="destructive">
            <AlertDescription>{error?.message}</AlertDescription>
          </Alert>
        )}
        {isEmpty && (
          // Composed from the low-level Empty primitives instead of EmptyState: EmptyState's title is a heading-role element that would double the card's own heading right above it.
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon" className="text-muted-foreground size-16 rounded-full">
                <MailX className="size-8" />
              </EmptyMedia>
              <EmptyDescription>{t('email.suppressions.empty')}</EmptyDescription>
              <EmptyDescription>{t('email.suppressions.emptyDescription')}</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>{addButton}</EmptyContent>
          </Empty>
        )}
        {data && !isEmpty && (
          <>
            <ItemGroup className="gap-1">
              {data.map((row) => (
                <Item key={row.address} role="listitem" variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      {row.address}
                      <Badge variant={row.reason === 'unsubscribed' ? 'warning' : 'secondary'}>
                        {t(`email.suppressions.reason.${row.reason}`)}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription>{dateLabel(row.createdAt)}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {row.sourceNewsletterId && (
                      <Button asChild variant="ghost" size="icon-sm">
                        <Link
                          to={`${NEWSLETTERS_PATH}/${row.sourceNewsletterId}?tab=history`}
                          aria-label={t('email.suppressions.openSource')}
                        >
                          <ExternalLink />
                        </Link>
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t('email.suppressions.remove', { address: row.address })}
                      onClick={() => setRemoving(row)}
                    >
                      <Trash2 />
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
            {addButton}
          </>
        )}
      </CardContent>

      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('email.suppressions.addTitle')}</DialogTitle>
            <DialogDescription>{t('email.suppressions.addDescription')}</DialogDescription>
          </DialogHeader>
          <Field>
            <FieldLabel htmlFor="suppression-address">{t('email.suppressions.address')}</FieldLabel>
            <Input
              id="suppression-address"
              type="email"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAdding(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button
              disabled={!parsed.success || add.isPending}
              onClick={() => {
                if (!parsed.success) return;
                add.mutate(parsed.data.address, {
                  onSuccess: () => {
                    setAddress('');
                    setAdding(false);
                  },
                });
              }}
            >
              {t('email.suppressions.addConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('email.suppressions.removeTitle')}
        description={t('email.suppressions.removeDescription', {
          address: removing?.address ?? '',
        })}
        confirmLabel={t('common:actions.remove')}
        cancelLabel={t('common:actions.cancel')}
        isLoading={remove.isPending}
        onConfirm={() => {
          if (!removing) return;
          remove.mutate(removing.address);
        }}
      />
    </Card>
  );
}
