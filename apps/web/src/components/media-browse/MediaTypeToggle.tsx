import { useTranslation } from 'react-i18next';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

export function MediaTypeToggle({
  value,
  onChange,
}: {
  value: 'movie' | 'show';
  onChange: (value: 'movie' | 'show') => void;
}) {
  const { t } = useTranslation('pages');

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as 'movie' | 'show')}
      variant="outline"
      aria-label={t('media.grid.toolbar.typeLabel')}
    >
      <ToggleGroupItem value="movie" aria-label={t('media.grid.toolbar.moviesToggle')}>
        {t('media.grid.toolbar.moviesToggle')}
      </ToggleGroupItem>
      <ToggleGroupItem value="show" aria-label={t('media.grid.toolbar.showsToggle')}>
        {t('media.grid.toolbar.showsToggle')}
      </ToggleGroupItem>
    </ToggleGroup>
  );
}
