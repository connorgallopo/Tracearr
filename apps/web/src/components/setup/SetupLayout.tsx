import { type ReactNode, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowLeft } from 'lucide-react';
import type { ServerType } from '@tracearr/shared';
import { LogoIcon } from '@/components/brand/Logo';
import { MediaServerIcon } from '@/components/icons/MediaServerIcon';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SetupStepRail, SetupStepStrip, type SetupStep } from './SetupSteps';

/** Where the signed-in steps live; the server type rides along so they know which server it is. */
export function setupPath(type: ServerType, step?: 'import') {
  const params = new URLSearchParams({ type });
  if (step) params.set('step', step);
  return `/setup?${params.toString()}`;
}

/**
 * The frame every first-run step sits in: the brand and the step list on the left, then the
 * step's title, its content and a footer that stays in view. Below lg the list becomes a strip.
 */
export function SetupLayout({
  steps,
  title,
  description,
  serverType,
  alert,
  back,
  actions,
  children,
}: {
  steps: SetupStep[];
  title: string;
  description: ReactNode;
  /** The server the step is about; its logo sits beside the title. */
  serverType?: ServerType;
  alert?: ReactNode;
  back?: { onClick: () => void; disabled?: boolean };
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const heading = useRef<HTMLHeadingElement>(null);
  const currentId = steps.find((step) => step.status === 'current')?.id;

  useEffect(() => {
    heading.current?.focus();
  }, [currentId]);

  return (
    <div className="bg-background flex min-h-screen items-center justify-center sm:p-4 lg:p-8">
      <Card className="w-full max-w-xl gap-0 overflow-clip py-0 max-sm:min-h-screen max-sm:rounded-none max-sm:border-0 max-sm:shadow-none lg:max-h-[calc(100dvh-4rem)] lg:min-h-[36rem] lg:max-w-4xl lg:flex-row">
        <aside className="bg-card-raised flex flex-col gap-6 border-b p-6 lg:w-64 lg:shrink-0 lg:gap-10 lg:border-r lg:border-b-0 lg:p-8">
          <div className="flex items-center gap-2.5">
            <LogoIcon className="size-8" />
            <span className="text-lg font-semibold tracking-tight">{t('pages:login.title')}</span>
          </div>
          <SetupStepRail steps={steps} />
          <SetupStepStrip steps={steps} />
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <div className="flex flex-col gap-2 px-6 pt-6 pb-6 lg:px-8 lg:pt-8">
            <div className="flex items-center gap-3">
              {serverType && (
                <MediaServerIcon type={serverType} alt="" className="size-9 shrink-0" />
              )}
              <h1
                ref={heading}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none"
              >
                {title}
              </h1>
            </div>
            <div className="text-muted-foreground max-w-prose text-sm">{description}</div>
          </div>

          <div className="flex min-h-0 flex-1 scrollbar-thin flex-col gap-4 overflow-y-auto px-6 pb-8 lg:px-8">
            {alert}
            {children}
          </div>

          <div className="bg-card flex items-center gap-2 border-t px-6 py-4 max-sm:sticky max-sm:bottom-0 lg:px-8">
            {back && (
              <Button
                variant="ghost"
                className="-ml-3"
                onClick={back.onClick}
                disabled={back.disabled}
              >
                <ArrowLeft />
                {t('common:actions.back')}
              </Button>
            )}
            {actions && <div className="ml-auto flex items-center gap-2">{actions}</div>}
          </div>
        </section>
      </Card>
    </div>
  );
}
