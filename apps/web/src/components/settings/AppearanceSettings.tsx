import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useTheme, ACCENT_PRESETS } from '@/components/theme-provider';
import { Sun, Moon, Monitor, Check, RotateCcw } from 'lucide-react';

type ThemeMode = 'light' | 'dark' | 'system';

const DEFAULT_THEME: ThemeMode = 'dark';
const DEFAULT_HUE = 187; // Cyan

const THEME_MODES: { value: ThemeMode; label: string; icon: typeof Sun; isDefault?: boolean }[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon, isDefault: true },
  { value: 'system', label: 'System', icon: Monitor },
];

export function AppearanceSettings() {
  const { theme, setTheme, accentHue, setAccentHue } = useTheme();

  const isDefault = theme === DEFAULT_THEME && accentHue === DEFAULT_HUE;

  const handleReset = () => {
    setTheme(DEFAULT_THEME);
    setAccentHue(DEFAULT_HUE);
  };

  return (
    <div className="space-y-4">
      {/* Theme Mode */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Theme</CardTitle>
              <CardDescription className="text-sm">
                Customize the look and feel of Tracearr
              </CardDescription>
            </div>
            {!isDefault && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleReset}
                className="text-muted-foreground hover:text-foreground gap-1.5"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Reset
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Mode Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Mode
            </label>
            <div className="flex gap-2">
              {THEME_MODES.map(({ value, label, icon: Icon, isDefault: isDefaultMode }) => (
                <Button
                  key={value}
                  variant={theme === value ? 'default' : 'outline'}
                  size="sm"
                  className={cn(
                    'flex-1 gap-1.5',
                    theme === value && 'ring-primary ring-offset-background ring-1 ring-offset-1'
                  )}
                  onClick={() => setTheme(value)}
                >
                  <Icon className="h-4 w-4" />
                  <span>{label}</span>
                  {isDefaultMode && <span className="text-[10px] opacity-60">(default)</span>}
                </Button>
              ))}
            </div>
          </div>

          {/* Accent Color Selection */}
          <div className="space-y-2">
            <label className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Accent Color
            </label>
            <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
              {ACCENT_PRESETS.map((preset) => {
                const isSelected = accentHue === preset.hue;
                const isDefaultColor = preset.hue === DEFAULT_HUE;
                return (
                  <button
                    key={preset.hue}
                    onClick={() => setAccentHue(preset.hue)}
                    className={cn(
                      'group relative flex flex-col items-center gap-1 rounded-lg p-1.5 transition-all',
                      'hover:bg-muted/50 focus:ring-primary focus:ring-offset-background focus:ring-2 focus:ring-offset-2 focus:outline-none'
                    )}
                    title={preset.name}
                  >
                    <div
                      className={cn(
                        'relative h-8 w-8 rounded-md transition-transform',
                        'group-hover:scale-105',
                        isSelected && 'ring-offset-background scale-105 ring-2 ring-offset-2'
                      )}
                      style={{
                        backgroundColor: preset.hex,
                        ['--tw-ring-color' as string]: isSelected ? preset.hex : undefined,
                      }}
                    >
                      {isSelected && (
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Check className="h-4 w-4 text-white drop-shadow-md" />
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        'text-[10px] leading-tight',
                        isSelected ? 'text-foreground font-medium' : 'text-muted-foreground'
                      )}
                    >
                      {preset.name}
                      {isDefaultColor && !isSelected && <span className="opacity-60">*</span>}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-[10px]">* Cyan is the default accent color</p>
          </div>
        </CardContent>
      </Card>

      {/* Preview */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Preview</CardTitle>
          <CardDescription className="text-sm">
            See how your theme looks with common UI elements
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs">Buttons</span>
              <div className="flex flex-wrap gap-1.5">
                <Button size="sm">Primary</Button>
                <Button size="sm" variant="secondary">
                  Secondary
                </Button>
                <Button size="sm" variant="outline">
                  Outline
                </Button>
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs">Badges</span>
              <div className="flex flex-wrap gap-1.5">
                <Badge className="text-xs">Default</Badge>
                <Badge variant="secondary" className="text-xs">
                  Secondary
                </Badge>
                <Badge variant="outline" className="text-xs">
                  Outline
                </Badge>
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs">Text</span>
              <div className="flex items-center gap-2 text-sm">
                <a
                  href="#"
                  className="text-primary hover:underline"
                  onClick={(e) => e.preventDefault()}
                >
                  Link
                </a>
                <span className="text-muted-foreground">•</span>
                <span className="text-primary">Accent</span>
                <span className="text-muted-foreground">•</span>
                <span className="text-muted-foreground">Muted</span>
              </div>
            </div>
            <div className="space-y-2">
              <span className="text-muted-foreground text-xs">Progress</span>
              <div className="flex items-center gap-2">
                <div className="bg-secondary h-2 max-w-32 flex-1 overflow-hidden rounded-full">
                  <div
                    className="bg-primary h-full rounded-full transition-all"
                    style={{ width: '65%' }}
                  />
                </div>
                <span className="text-muted-foreground text-xs">65%</span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
