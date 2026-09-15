import { useTranslation } from 'react-i18next';
import { Monitor, Moon, RotateCcw, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldGroup, FieldTitle } from '@/components/ui/field';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ACCENT_PRESETS, useTheme, type Theme } from '@/components/theme-provider';
import { ColorSwatchPicker } from '@/components/settings/shared/ColorSwatchPicker';
import { SettingsSection } from '@/components/settings/shell/SettingsSection';

const DEFAULT_THEME: Theme = 'dark';
const DEFAULT_HUE = 187;

const THEME_MODES = [
  { value: 'light' as const, labelKey: 'general.themeLight' as const, icon: Sun },
  { value: 'dark' as const, labelKey: 'general.themeDark' as const, icon: Moon, isDefault: true },
  { value: 'system' as const, labelKey: 'general.themeSystem' as const, icon: Monitor },
];

const ACCENT_OPTIONS = ACCENT_PRESETS.map((preset) => ({
  id: String(preset.hue),
  name: preset.name,
  hex: preset.hex,
}));

export function Appearance() {
  const { t } = useTranslation(['settings', 'common']);
  const { theme, setTheme, accentHue, setAccentHue } = useTheme();
  const isDefault = theme === DEFAULT_THEME && accentHue === DEFAULT_HUE;

  return (
    <SettingsSection
      title={t('nav.sections.appearance')}
      description={t('nav.descriptions.appearance')}
    >
      <FieldGroup>
        <Field>
          <FieldTitle>{t('general.theme')}</FieldTitle>
          {/* Field stretches its direct children; the wrapper takes that so the group stays w-fit. */}
          <div>
            <ToggleGroup
              type="single"
              variant="outline"
              aria-label={t('general.theme')}
              value={theme}
              onValueChange={(value) => {
                if (value) setTheme(value as Theme);
              }}
            >
              {THEME_MODES.map(({ value, labelKey, icon: Icon, isDefault: isDefaultMode }) => (
                <ToggleGroupItem key={value} value={value} aria-label={t(labelKey)}>
                  <Icon className="h-4 w-4" />
                  {t(labelKey)}
                  {isDefaultMode && (
                    <span className="text-[10px] opacity-60">{t('general.default')}</span>
                  )}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
        </Field>

        <Field>
          <FieldTitle>{t('general.accentColor')}</FieldTitle>
          <ColorSwatchPicker
            label={t('general.accentColor')}
            options={ACCENT_OPTIONS}
            value={String(accentHue)}
            onChange={(id) => {
              setAccentHue(Number(id));
            }}
          />
          <FieldDescription>{t('general.cyanDefault')}</FieldDescription>
        </Field>

        {!isDefault && (
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground w-fit gap-1.5"
            onClick={() => {
              setTheme(DEFAULT_THEME);
              setAccentHue(DEFAULT_HUE);
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t('common:actions.reset')}
          </Button>
        )}
      </FieldGroup>
    </SettingsSection>
  );
}
