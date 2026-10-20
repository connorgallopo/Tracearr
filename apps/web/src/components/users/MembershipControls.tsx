import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MembershipEnforcementPolicy,
  MembershipStatus,
  MembershipType,
} from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FieldError } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useUpdateUserIdentity } from '@/hooks/queries/useUsers';

const typeOptions = [
  { value: 'normal', label: 'userDetail.membership.normal' },
  { value: 'lifetime', label: 'userDetail.membership.lifetime' },
  { value: 'whitelisted', label: 'userDetail.membership.whitelisted' },
] as const;

const policyOptions = [
  { value: 'kill_first_stream_daily', label: 'userDetail.membership.killFirstDaily' },
  { value: 'kill_every_play', label: 'userDetail.membership.killEveryPlay' },
  { value: 'kill_every_2_plays', label: 'userDetail.membership.killEvery2' },
  { value: 'kill_every_3_plays', label: 'userDetail.membership.killEvery3' },
  { value: 'allow_all', label: 'userDetail.membership.allowAll' },
] as const;

export function MembershipControls({
  serverUserId,
  identityName,
  identityType,
  identityExpirationDate,
  identityPolicy,
}: {
  serverUserId: string;
  identityName: string;
  identityType: MembershipType;
  identityExpirationDate: string | null;
  identityPolicy: MembershipEnforcementPolicy | null;
}) {
  const { t } = useTranslation('pages');
  const update = useUpdateUserIdentity();
  const [type, setType] = useState<MembershipType>(identityType);
  const [expirationDate, setExpirationDate] = useState(identityExpirationDate ?? '');
  const [policy, setPolicy] = useState<MembershipEnforcementPolicy>(
    identityPolicy ?? 'kill_first_stream_daily'
  );
  const today = new Date().toISOString().slice(0, 10);
  const status: MembershipStatus =
    type === 'normal' ? (expirationDate && expirationDate >= today ? 'paid' : 'unpaid') : type;

  return (
    <section className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="font-semibold">{t('userDetail.membership.title')}</h3>
        <p className="text-muted-foreground text-sm">
          {t('userDetail.membership.description', { name: identityName })}
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t('userDetail.membership.accountType')}</span>
          <Select
            value={type}
            onValueChange={(value) => {
              const selected = typeOptions.find((option) => option.value === value);
              if (selected) setType(selected.value);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {typeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <div className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t('userDetail.membership.status')}</span>
          <p className="flex h-9 items-center font-medium">
            {t(`userDetail.membership.${status}`)}
          </p>
        </div>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t('userDetail.membership.expirationDate')}</span>
          <Input
            type="date"
            value={expirationDate}
            onChange={(event) => setExpirationDate(event.target.value)}
            disabled={type !== 'normal'}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span className="text-muted-foreground">{t('userDetail.membership.policy')}</span>
          <Select
            value={policy}
            onValueChange={(value) => {
              const selected = policyOptions.find((option) => option.value === value);
              if (selected) setPolicy(selected.value);
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {policyOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground block">
            {t('userDetail.membership.policyAppliesToUnpaid')}
          </span>
        </label>
      </div>
      <Button
        size="sm"
        onClick={() =>
          update.mutate({
            id: serverUserId,
            data: {
              membershipType: type,
              membershipExpirationDate: expirationDate || null,
              membershipEnforcementPolicy: policy,
            },
          })
        }
        disabled={update.isPending}
      >
        {t('userDetail.membership.saveIdentity')}
      </Button>
      {update.error && <FieldError>{update.error.message}</FieldError>}
    </section>
  );
}
