import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

export type SetupStepId = 'server' | 'account' | 'connect' | 'import';

export interface SetupStep {
  id: SetupStepId;
  status: 'done' | 'current' | 'upcoming';
  /** What was chosen, shown beneath the step's name. */
  detail?: string;
  /** Present only on a step the owner may go back to; it renders as a button. */
  onSelect?: () => void;
}

const SETUP_STEP_IDS: readonly SetupStepId[] = ['server', 'account', 'connect', 'import'];

/** The four steps with everything before `current` done; `parts` adds what was chosen and where to go back to. */
export function setupSteps(
  current: SetupStepId,
  parts: Partial<Record<SetupStepId, Pick<SetupStep, 'detail' | 'onSelect'>>> = {}
): SetupStep[] {
  const currentIndex = SETUP_STEP_IDS.indexOf(current);
  return SETUP_STEP_IDS.map((id, index) => ({
    id,
    status: index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'upcoming',
    ...parts[id],
  }));
}

const STATUS_KEY = {
  done: 'setup.stepStatus.done',
  current: 'setup.stepStatus.current',
  upcoming: 'setup.stepStatus.upcoming',
} as const;

function StepDot({ status, number }: { status: SetupStep['status']; number: number }) {
  return (
    <span
      aria-hidden
      className={cn(
        'grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold',
        status === 'done' && 'bg-primary text-primary-foreground',
        status === 'current' && 'border-primary bg-card-raised text-primary border-2',
        status === 'upcoming' && 'bg-card-raised text-muted-foreground border'
      )}
    >
      {status === 'done' ? <Check className="size-3.5" strokeWidth={3} /> : number}
    </span>
  );
}

function StepName({ step }: { step: SetupStep }) {
  const { t } = useTranslation('pages');

  return (
    <span
      className={cn(
        'text-sm',
        step.status === 'current' && 'font-semibold',
        step.status === 'done' && 'font-medium',
        step.status === 'upcoming' && 'text-muted-foreground'
      )}
    >
      {t(`setup.steps.${step.id}`)}
      <span className="sr-only">, {t(STATUS_KEY[step.status])}</span>
    </span>
  );
}

export function SetupStepRail({ steps }: { steps: SetupStep[] }) {
  const { t } = useTranslation('pages');

  return (
    <nav aria-label={t('setup.stepsLabel')} className="hidden lg:block">
      <ol className="flex flex-col">
        {steps.map((step, index) => (
          <li
            key={step.id}
            aria-current={step.status === 'current' ? 'step' : undefined}
            className="relative flex gap-3 pb-8 last:pb-0"
          >
            {index < steps.length - 1 && (
              <span
                aria-hidden
                className={cn(
                  'absolute top-9 bottom-1 left-3.5 w-px -translate-x-1/2',
                  step.status === 'done' ? 'bg-primary' : 'bg-border'
                )}
              />
            )}
            <StepDot status={step.status} number={index + 1} />
            <div className="flex min-w-0 flex-col items-start gap-0.5 pt-1">
              {step.onSelect ? (
                <button
                  type="button"
                  onClick={step.onSelect}
                  className="focus-visible:ring-ring rounded-sm text-left underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                >
                  <StepName step={step} />
                </button>
              ) : (
                <StepName step={step} />
              )}
              {step.detail && (
                <span className="text-muted-foreground max-w-full truncate text-xs">
                  {step.detail}
                </span>
              )}
            </div>
          </li>
        ))}
      </ol>
    </nav>
  );
}

/** The rail's stand-in below lg: four segments and which step this is. */
export function SetupStepStrip({ steps }: { steps: SetupStep[] }) {
  const { t } = useTranslation('pages');
  const index = steps.findIndex((step) => step.status === 'current');
  const current = steps[index];

  return (
    <div className="flex flex-col gap-2 lg:hidden">
      <div className="grid grid-cols-4 gap-1" aria-hidden>
        {steps.map((step) => (
          <span
            key={step.id}
            className={cn(
              'h-1 rounded-full',
              step.status === 'upcoming' ? 'bg-muted' : 'bg-primary'
            )}
          />
        ))}
      </div>
      {current && (
        <p className="text-muted-foreground text-xs">
          {t('setup.stepOfNamed', {
            step: index + 1,
            total: steps.length,
            name: t(`setup.steps.${current.id}`),
          })}
        </p>
      )}
    </div>
  );
}
