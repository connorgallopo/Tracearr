import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { formatDistanceToNow } from 'date-fns';
import { ArrowLeft, Pencil, Share2 } from 'lucide-react';
import { RETENTION_DEFAULTS } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ItemMedia } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  ActivityList,
  AutomationDetailForm,
  AutomationKindBadge,
  ProvenanceLine,
  RunDetail,
  ScopeChip,
  TemplateBadge,
} from '@/components/automations';
import { ExportDialog } from '@/components/automations/sharing/ExportDialog';
import { automationIcon } from '@/lib/automations';
import { useAutomation, useToggleAutomation } from '@/hooks/queries';
import { useRunCounts } from '@/hooks/queries/useRuns';
import { usePageTitle } from '@/hooks/useDocumentTitle';
import { useServer } from '@/hooks/useServer';

export function AutomationDetail() {
  const { t } = useTranslation(['pages', 'common']);
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { servers } = useServer();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);

  const { data: automation, isLoading } = useAutomation(id);
  const toggleAutomation = useToggleAutomation();

  usePageTitle(automation?.name);

  if (isLoading) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-36" />
          <Skeleton className="h-8 w-48" />
        </div>
        <Skeleton className="h-64" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="mx-auto w-full max-w-4xl space-y-6">
        <BackLink label={t('common:actions.back')} />
        <Card>
          <CardContent className="flex h-32 items-center justify-center">
            <p className="text-muted-foreground">{t('pages:automations.detail.notFound')}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  const template = automation.template;

  return (
    <div className="mx-auto w-full max-w-4xl">
      <BackLink label={t('common:actions.back')} />

      <div className="mt-3 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <ItemMedia variant="icon" className="size-10">
            {automationIcon(automation)}
          </ItemMedia>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold">{automation.name}</h1>
              <AutomationKindBadge kind={automation.kind} />
              <ScopeChip automation={automation} servers={servers} />
              {template && <TemplateBadge template={template} />}
            </div>
            <ProvenanceLine automation={automation} />
            <RunLine automationId={automation.id} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Switch
            checked={automation.isActive}
            onCheckedChange={(isActive) => {
              toggleAutomation.mutate({ id: automation.id, isActive });
            }}
            aria-label={t('pages:automations.toggleAutomation', { name: automation.name })}
          />
          <Button variant="outline" onClick={() => setExportOpen(true)}>
            <Share2 />
            {t('common:actions.export')}
          </Button>
          {!template && (
            <Button
              variant="outline"
              onClick={() => void navigate(`/automations/${automation.id}/edit`)}
            >
              <Pencil />
              {t('common:actions.edit')}
            </Button>
          )}
        </div>
      </div>

      <AutomationDetailForm automation={automation} template={template} />

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t('pages:automations.activity.title')}</CardTitle>
          <CardDescription>
            {t('pages:automations.activity.description', {
              days: automation.retentionDays ?? RETENTION_DEFAULTS[automation.kind],
            })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ActivityList automation={automation} onSelectRun={setSelectedRunId} />
        </CardContent>
      </Card>

      {exportOpen && <ExportDialog automation={automation} open onOpenChange={setExportOpen} />}

      <RunDetail
        runId={selectedRunId}
        canReplay={template === null}
        onOpenChange={(open) => {
          if (!open) setSelectedRunId(null);
        }}
      />
    </div>
  );
}

/** How much this row has done, from the counts the Activity tabs already read. */
function RunLine({ automationId }: { automationId: string }) {
  const { t } = useTranslation('pages');
  const { data: counts, isLoading } = useRunCounts(automationId);

  if (isLoading) return <Skeleton className="mt-1 h-4 w-56" />;

  const lastRunAt = counts?.lastRunAt;
  if (!counts || counts.completed === 0 || !lastRunAt) {
    return <p className="text-muted-foreground text-xs">{t('automations.detail.noRuns')}</p>;
  }

  return (
    <p className="text-muted-foreground text-xs">
      {t('automations.detail.runsLine', {
        count: counts.completed,
        when: formatDistanceToNow(new Date(lastRunAt), { addSuffix: true }),
      })}
    </p>
  );
}

function BackLink({ label }: { label: string }) {
  return (
    <Link to="/automations">
      <Button variant="ghost" size="sm" className="-ml-2">
        <ArrowLeft />
        {label}
      </Button>
    </Link>
  );
}
