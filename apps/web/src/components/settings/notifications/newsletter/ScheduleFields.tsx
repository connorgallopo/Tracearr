import { useTranslation } from 'react-i18next';
import type { NewsletterSchedule } from '@tracearr/shared';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TimezoneSelect } from '@/components/settings/shared/TimezoneSelect';
import { dateLabel } from '@/components/settings/shared/dateLabel';
import { NEWSLETTER_FIELD_IDS, type FieldsetProps } from './newsletterForm';

const KINDS = ['daily', 'weekly', 'monthly', 'cron'] as const;
const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;
const DAYS_OF_MONTH = Array.from({ length: 28 }, (_, i) => i + 1);

/** 2026-08-30 is a Sunday, so day 0..6 lands on the matching weekday name. */
const weekdayName = (day: number, locale: string) =>
  new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 7, 30 + day))
  );

const clockOf = (schedule: NewsletterSchedule): string =>
  schedule.kind === 'cron' ? '09:00' : schedule.time;

function withKind(schedule: NewsletterSchedule, kind: (typeof KINDS)[number]): NewsletterSchedule {
  const time = clockOf(schedule);
  switch (kind) {
    case 'daily':
      return { kind, time };
    case 'weekly':
      return { kind, dayOfWeek: schedule.kind === 'weekly' ? schedule.dayOfWeek : 1, time };
    case 'monthly':
      return { kind, dayOfMonth: schedule.kind === 'monthly' ? schedule.dayOfMonth : 1, time };
    case 'cron':
      return { kind, expression: '0 9 * * 1' };
  }
}

export function ScheduleFields({
  state,
  onChange,
  errors,
  mode,
  nextRunAt,
}: FieldsetProps & { nextRunAt?: string | null }) {
  const { t, i18n } = useTranslation('settings');
  const { schedule } = state;
  const setSchedule = (next: NewsletterSchedule) => onChange({ schedule: next });

  return (
    <FieldSet>
      <FieldLegend>{t('newsletters.editor.schedule')}</FieldLegend>
      <div className="flex flex-wrap gap-4">
        <Field className="w-44">
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.scheduleKind}>
            {t('newsletters.editor.scheduleKind')}
          </FieldLabel>
          <Select
            value={schedule.kind}
            onValueChange={(kind) =>
              setSchedule(withKind(schedule, kind as (typeof KINDS)[number]))
            }
          >
            <SelectTrigger
              id={NEWSLETTER_FIELD_IDS.scheduleKind}
              aria-label={t('newsletters.editor.scheduleKind')}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`newsletters.editor.kinds.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {schedule.kind === 'weekly' && (
          <Field className="w-44">
            <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.dayOfWeek}>
              {t('newsletters.editor.dayOfWeek')}
            </FieldLabel>
            <Select
              value={String(schedule.dayOfWeek)}
              onValueChange={(day) => setSchedule({ ...schedule, dayOfWeek: Number(day) })}
            >
              <SelectTrigger
                id={NEWSLETTER_FIELD_IDS.dayOfWeek}
                aria-label={t('newsletters.editor.dayOfWeek')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS.map((day) => (
                  <SelectItem key={day} value={String(day)}>
                    {weekdayName(day, i18n.language)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {schedule.kind === 'monthly' && (
          <Field className="w-44">
            <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.dayOfMonth}>
              {t('newsletters.editor.dayOfMonth')}
            </FieldLabel>
            <Select
              value={String(schedule.dayOfMonth)}
              onValueChange={(day) => setSchedule({ ...schedule, dayOfMonth: Number(day) })}
            >
              <SelectTrigger
                id={NEWSLETTER_FIELD_IDS.dayOfMonth}
                aria-label={t('newsletters.editor.dayOfMonth')}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAYS_OF_MONTH.map((day) => (
                  <SelectItem key={day} value={String(day)}>
                    {day}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {schedule.kind !== 'cron' && (
          <Field className="w-36">
            <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.time}>
              {t('newsletters.editor.time')}
            </FieldLabel>
            <Input
              id={NEWSLETTER_FIELD_IDS.time}
              type="time"
              value={schedule.time}
              onChange={(event) => setSchedule({ ...schedule, time: event.target.value })}
            />
          </Field>
        )}
        <Field className="w-full max-w-sm">
          <FieldLabel id={`${NEWSLETTER_FIELD_IDS.timezone}-label`}>
            {t('newsletters.editor.timezone')}
          </FieldLabel>
          <TimezoneSelect
            id={NEWSLETTER_FIELD_IDS.timezone}
            aria-labelledby={`${NEWSLETTER_FIELD_IDS.timezone}-label`}
            value={state.timezone}
            onChange={(timezone) => onChange({ timezone })}
          />
          <FieldError>{errors.timezone}</FieldError>
        </Field>
      </div>
      {schedule.kind === 'cron' && (
        <Field className="max-w-sm" data-invalid={errors.schedule !== undefined}>
          <FieldLabel htmlFor={NEWSLETTER_FIELD_IDS.cron}>
            {t('newsletters.editor.cron')}
          </FieldLabel>
          <Input
            id={NEWSLETTER_FIELD_IDS.cron}
            value={schedule.expression}
            className="font-mono"
            aria-invalid={errors.schedule !== undefined}
            onChange={(event) => setSchedule({ kind: 'cron', expression: event.target.value })}
          />
          <FieldDescription>{t('newsletters.editor.cronHint')}</FieldDescription>
          <FieldDescription>{t('newsletters.editor.dstNote')}</FieldDescription>
          <FieldError>{errors.schedule}</FieldError>
        </Field>
      )}
      {schedule.kind !== 'cron' && <FieldError>{errors.schedule}</FieldError>}
      {mode === 'edit' && (
        <FieldDescription>
          {nextRunAt
            ? t('newsletters.editor.nextRun', { when: dateLabel(nextRunAt) })
            : t('newsletters.noNextRun')}
        </FieldDescription>
      )}
    </FieldSet>
  );
}
