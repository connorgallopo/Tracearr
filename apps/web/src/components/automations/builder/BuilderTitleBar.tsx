import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldLabel } from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';

interface BuilderTitleBarProps {
  title: string;
  active: boolean;
  onActiveChange: (value: boolean) => void;
  onBack: () => void;
}

/** The page's own line: where it goes back to, what it is, and whether it runs. */
export function BuilderTitleBar({ title, active, onActiveChange, onBack }: BuilderTitleBarProps) {
  const { t } = useTranslation(['pages', 'common']);
  const activeId = useId();

  return (
    <div className="mb-5 flex items-center gap-3">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t('common:actions.back')}
        onClick={onBack}
      >
        <ChevronLeft />
      </Button>
      <h1 className="min-w-0 text-xl font-semibold">{title}</h1>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <FieldLabel htmlFor={activeId} className="text-muted-foreground text-sm">
          {t('pages:automations.builder.activeLabel')}
        </FieldLabel>
        <Switch id={activeId} checked={active} onCheckedChange={onActiveChange} />
      </div>
    </div>
  );
}
