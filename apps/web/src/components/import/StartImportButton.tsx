import { useTranslation } from 'react-i18next';
import { Loader2, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ImportPhase } from '@/hooks/queries/useImports';

/** Every import source's start button: none while the import waits, busy while it runs, and offered again once it failed. */
export function StartImportButton({
  phase,
  onClick,
  disabled,
  icon: Icon,
  label,
}: {
  phase: ImportPhase;
  onClick: () => void;
  disabled: boolean;
  icon: LucideIcon;
  label: string;
}) {
  const { t } = useTranslation('settings');

  if (phase === 'pending') return null;
  const importing = phase === 'importing';

  return (
    <Button onClick={onClick} disabled={disabled || importing} size="lg">
      {importing ? (
        <>
          <Loader2 className="animate-spin" />
          {t('import.importing')}
        </>
      ) : (
        <>
          <Icon />
          {phase === 'failed' ? t('import.startAgain') : label}
        </>
      )}
    </Button>
  );
}
