import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, CircleDot, MinusCircle, PencilRuler, X, XCircle } from 'lucide-react';
import {
  isPlacedLocal,
  LOCAL_NETWORK_COUNTRY,
  type AutomationRun,
  type GroupEvidence,
  type RunSessionContext,
} from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { AutomationKindBadge } from '@/components/automations/AutomationKindBadge';
import { UserCell } from '@/components/users/UserCell';
import { MediaPageLink } from '@/components/media/MediaPageLink';
import { useRun } from '@/hooks/queries/useRuns';
import { useDescribeRefs } from '@/hooks/useDescribeRefs';
import {
  conditionText,
  evidenceValueText,
  isKnownTrigger,
  runWhere,
  runWho,
  storedActionLabel,
  triggerLabel,
  type Translate,
} from '@/lib/automations';
import { getMediaDisplay, getMediaLinks } from '@/lib/utils';
import { formatDate } from '@/lib/dateFormat';

/** Step zero, as the recorder writes it. */
interface TriggerStep {
  type: string;
  edgeKey: string | null;
}

/** Every later step is one action result. */
interface ActionStep {
  action: string;
  success: boolean;
  skipped: boolean;
  skipReason: string | null;
  message: string | null;
  /** `if` only: the branch that ran and what its conditions read. */
  branch: 'then' | 'else' | null;
  evidence: GroupEvidence[];
  /** A leaf inside a branch names the `if` it sits under. */
  nested: boolean;
}

const isRecord = (step: unknown): step is Record<string, unknown> =>
  typeof step === 'object' && step !== null;

const asTriggerStep = (step: unknown): TriggerStep | null => {
  if (!isRecord(step) || !isRecord(step.trigger)) return null;
  const { type, edgeKey } = step.trigger;
  if (typeof type !== 'string') return null;
  return { type, edgeKey: typeof edgeKey === 'string' ? edgeKey : null };
};

const asActionStep = (step: unknown): ActionStep | null => {
  if (!isRecord(step)) return null;
  const { action, success, skipped, skipReason, message, branch, evidence, path } = step;
  if (typeof action !== 'string' || typeof success !== 'boolean') return null;
  return {
    action,
    success,
    skipped: skipped === true,
    skipReason: typeof skipReason === 'string' ? skipReason : null,
    message: typeof message === 'string' ? message : null,
    branch: branch === 'then' || branch === 'else' ? branch : null,
    evidence: Array.isArray(evidence) ? (evidence as GroupEvidence[]) : [],
    nested: typeof path === 'string',
  };
};

interface RunDetailProps {
  runId: string | null;
  /** A template-bound row has no builder to replay into. */
  canReplay?: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RunDetail({ runId, canReplay = false, onOpenChange }: RunDetailProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { data: run, isLoading } = useRun(runId ?? undefined);

  return (
    <Sheet open={runId !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{t('pages:automations.activity.runTitle')}</SheetTitle>
          <SheetDescription>
            {run
              ? formatDate(new Date(run.startedAt), { dateStyle: 'medium', timeStyle: 'medium' })
              : t('pages:automations.activity.runLoading')}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 px-4 pb-6">
          {isLoading && <Skeleton className="h-40 w-full" />}

          {run && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {t(`pages:automations.activity.outcomes.${run.outcome}`)}
                </Badge>
                <AutomationKindBadge kind={run.kind} />
              </div>

              <RunSubjectBlock run={run} />

              {run.humanSummary && <p className="text-sm">{run.humanSummary}</p>}

              <Verdicts run={run} />

              {canReplay && run.sessionId !== null && (
                <ReplayButton automationId={run.automationId} sessionId={run.sessionId} />
              )}
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

/** Who it was about, where, and what was playing at the time. */
function RunSubjectBlock({ run }: { run: AutomationRun }) {
  const { t } = useTranslation('pages');

  const rows: { label: string; value: ReactNode }[] = [];
  const person = run.subject.kind === 'session' || run.subject.kind === 'account';
  const who = runWho(run.subject);
  if (who) {
    rows.push({
      label: t('automations.activity.who'),
      value: person ? (
        <UserCell
          serverUserId={run.serverUserId}
          username={run.subject.name}
          identityName={run.subject.personName}
          thumbUrl={run.subject.thumbUrl}
          serverId={run.serverId}
        />
      ) : (
        who
      ),
    });
  }
  const where = runWhere(run.subject);
  if (where) rows.push({ label: t('automations.activity.where'), value: where });

  const playing = run.session ? playingValue(run.session) : null;
  if (playing) rows.push({ label: t('automations.activity.playing'), value: playing });

  const from = run.session ? fromText(run.session) : null;
  if (from) rows.push({ label: t('automations.activity.from'), value: from });

  rows.push({
    label: t('automations.activity.started'),
    value: formatDate(new Date(run.startedAt), { dateStyle: 'medium', timeStyle: 'medium' }),
  });

  // The table dropped this column because it repeats Started; the sheet is where it belongs.
  if (run.finishedAt !== null) {
    rows.push({
      label: t('automations.activity.finished'),
      value: formatDate(new Date(run.finishedAt), { dateStyle: 'medium', timeStyle: 'medium' }),
    });
  }

  return (
    <dl className="bg-muted/40 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg p-3 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The show and the episode, when the session names both. */
function playingValue(session: RunSessionContext): ReactNode {
  if (session.mediaTitle === null) return null;
  const { title, subtitle } = getMediaDisplay(session);
  const links = getMediaLinks(session);
  return (
    <>
      <MediaPageLink to={links.title}>{title}</MediaPageLink>
      {subtitle && subtitle !== title && (
        <>
          {' · '}
          <MediaPageLink to={links.subtitle}>{subtitle}</MediaPageLink>
        </>
      )}
    </>
  );
}

/** The client, then where it was streaming from. */
function fromText(session: RunSessionContext): string | null {
  const client = session.player ?? session.product ?? session.device ?? session.platform;
  const joined = [session.city, session.country].filter((part) => part !== null).join(', ');
  const place =
    joined && isPlacedLocal({ isLocal: session.isLocal, country: session.country })
      ? `${joined} (${LOCAL_NETWORK_COUNTRY})`
      : joined;
  const parts = [client, session.ipAddress, place || null].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The trigger that fired, each condition, then what every action did. */
function Verdicts({ run }: { run: AutomationRun }) {
  const { t } = useTranslation('pages');
  const trigger = asTriggerStep(run.steps[0]);
  const actions = run.steps.slice(1);
  const groups = Array.isArray(run.evidence) ? run.evidence : [];

  return (
    <ol className="space-y-2">
      <li className="flex items-start gap-3 rounded-lg border p-3">
        <CircleDot className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium">
            {t('automations.activity.triggeredBy', {
              trigger:
                trigger && isKnownTrigger(trigger.type)
                  ? triggerLabel(t, trigger.type)
                  : (trigger?.type ?? t('automations.activity.unknownStep')),
            })}
          </p>
          {trigger?.edgeKey && (
            <p className="text-muted-foreground font-mono text-xs break-all">{trigger.edgeKey}</p>
          )}
        </div>
      </li>

      {groups.map((group, index) => (
        <li key={group.groupIndex} className="rounded-lg border p-3">
          {groups.length > 1 && (
            <p className="text-muted-foreground mb-1 text-xs">
              {t('automations.activity.group', { number: index + 1 })}
            </p>
          )}
          <ConditionVerdicts t={t} group={group} />
        </li>
      ))}

      {actions.map((step, index) => (
        <ActionVerdict key={index} step={step} />
      ))}
    </ol>
  );
}

function ConditionVerdicts({ t, group }: { t: Translate; group: GroupEvidence }) {
  const refs = useDescribeRefs();
  return (
    <ul className="space-y-1">
      {group.conditions.map((condition, index) => (
        <li key={`${condition.field}:${index}`} className="flex flex-wrap items-center gap-1.5">
          {condition.matched ? (
            <Check className="text-success size-3.5 shrink-0" />
          ) : (
            <X className="text-destructive size-3.5 shrink-0" />
          )}
          <span className="sr-only">
            {condition.matched
              ? t('automations.builder.liveCheck.passed')
              : t('automations.builder.liveCheck.notPassed')}
          </span>
          <span className="text-sm">{conditionText(t, condition, refs)}</span>
          <span className="text-muted-foreground text-xs">
            {t('automations.builder.liveCheck.actual', {
              value: evidenceValueText(t, refs, condition.field, condition.actual),
            })}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ActionVerdict({ step }: { step: unknown }) {
  const { t } = useTranslation('pages');
  const action = asActionStep(step);

  if (!action) {
    return (
      <li className="flex items-start gap-3 rounded-lg border p-3">
        <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        <p className="text-muted-foreground text-sm">{t('automations.activity.unknownStep')}</p>
      </li>
    );
  }

  const note = action.skipped ? action.skipReason : action.success ? null : action.message;

  return (
    <li className={action.nested ? 'ml-4' : undefined}>
      <div className="flex items-start gap-3 rounded-lg border p-3">
        {action.skipped ? (
          <MinusCircle className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        ) : action.success ? (
          <Check className="text-primary mt-0.5 size-4 shrink-0" />
        ) : (
          <XCircle className="text-destructive mt-0.5 size-4 shrink-0" />
        )}
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-sm font-medium">{storedActionLabel(t, action.action)}</p>
          {action.branch && (
            <p className="text-muted-foreground text-xs">
              {t(`automations.activity.branch.${action.branch}`)}
            </p>
          )}
          {note && <p className="text-muted-foreground text-xs">{note}</p>}
          {action.evidence.length > 0 && (
            <Collapsible>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm" className="-ml-2 h-6 px-2 text-xs">
                  <ChevronDown />
                  {t('automations.activity.whyBranch')}
                </Button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-1">
                {action.evidence.map((group) => (
                  <ConditionVerdicts key={group.groupIndex} t={t} group={group} />
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </div>
      </div>
    </li>
  );
}

/** Opens the builder with this run's session as the live check's sample. */
function ReplayButton({ automationId, sessionId }: { automationId: string; sessionId: string }) {
  const { t } = useTranslation('pages');
  const navigate = useNavigate();

  return (
    <Button
      variant="outline"
      onClick={() => void navigate(`/automations/${automationId}/edit?sample=${sessionId}`)}
    >
      <PencilRuler />
      {t('automations.activity.openInEditor')}
    </Button>
  );
}
