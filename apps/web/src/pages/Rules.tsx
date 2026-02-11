import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NumericInput } from '@/components/ui/numeric-input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Checkbox } from '@/components/ui/checkbox';
import { BulkActionsToolbar, type BulkAction } from '@/components/ui/bulk-actions-toolbar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Plus,
  Pencil,
  Trash2,
  Shield,
  MapPin,
  Zap,
  Users,
  Globe,
  Clock,
  Power,
  PowerOff,
  ChevronDown,
  Sparkles,
  Settings2,
} from 'lucide-react';
import { CountryMultiSelect } from '@/components/ui/country-multi-select';
import { getCountryName } from '@/lib/utils';
import type {
  Rule,
  RuleType,
  RuleParams,
  UnitSystem,
  CreateRuleV2Input,
  UpdateRuleV2Input,
  RulesFilterOptions,
} from '@tracearr/shared';
import { RuleBuilderDialog, getRuleIcon, getRuleSummary, isV2Rule } from '@/components/rules';
import { CLASSIC_RULE_TEMPLATES, type ClassicRuleTemplate } from '@/lib/rules';
import {
  getSpeedUnit,
  getDistanceUnit,
  fromMetricDistance,
  toMetricDistance,
} from '@tracearr/shared';
import {
  useRules,
  useCreateRule,
  useUpdateRule,
  useDeleteRule,
  useToggleRule,
  useBulkToggleRules,
  useBulkDeleteRules,
  useSettings,
} from '@/hooks/queries';
import { useCreateRuleV2, useUpdateRuleV2 } from '@/hooks/queries/useRulesV2';
import { useRulesFilterOptions } from '@/hooks/queries/useHistory';
import { useRowSelection } from '@/hooks/useRowSelection';

const RULE_TYPE_ICONS: Record<RuleType, React.ReactNode> = {
  impossible_travel: <MapPin className="h-4 w-4" />,
  simultaneous_locations: <Users className="h-4 w-4" />,
  device_velocity: <Zap className="h-4 w-4" />,
  concurrent_streams: <Shield className="h-4 w-4" />,
  geo_restriction: <Globe className="h-4 w-4" />,
  account_inactivity: <Clock className="h-4 w-4" />,
};

function useRuleTypes() {
  const { t } = useTranslation('pages');
  return [
    {
      value: 'impossible_travel' as RuleType,
      label: t('rules.impossibleTravel'),
      icon: RULE_TYPE_ICONS['impossible_travel'],
      description: t('rules.impossibleTravelDesc'),
    },
    {
      value: 'simultaneous_locations' as RuleType,
      label: t('rules.simultaneousLocations'),
      icon: RULE_TYPE_ICONS['simultaneous_locations'],
      description: t('rules.simultaneousLocationsDesc'),
    },
    {
      value: 'device_velocity' as RuleType,
      label: t('rules.deviceVelocity'),
      icon: RULE_TYPE_ICONS['device_velocity'],
      description: t('rules.deviceVelocityDesc'),
    },
    {
      value: 'concurrent_streams' as RuleType,
      label: t('rules.concurrentStreams'),
      icon: RULE_TYPE_ICONS['concurrent_streams'],
      description: t('rules.concurrentStreamsDesc'),
    },
    {
      value: 'geo_restriction' as RuleType,
      label: t('rules.geoRestriction'),
      icon: RULE_TYPE_ICONS['geo_restriction'],
      description: t('rules.geoRestrictionDesc'),
    },
    {
      value: 'account_inactivity' as RuleType,
      label: t('rules.accountInactivity'),
      icon: RULE_TYPE_ICONS['account_inactivity'],
      description: t('rules.accountInactivityDesc'),
    },
  ];
}

const DEFAULT_PARAMS: Record<RuleType, RuleParams> = {
  impossible_travel: { maxSpeedKmh: 500, excludePrivateIps: false },
  simultaneous_locations: { minDistanceKm: 100, excludePrivateIps: false },
  device_velocity: { maxIps: 5, windowHours: 24, excludePrivateIps: false, groupByDevice: false },
  concurrent_streams: { maxStreams: 3, excludePrivateIps: false },
  geo_restriction: { mode: 'blocklist', countries: [], excludePrivateIps: false },
  account_inactivity: {
    inactivityValue: 30,
    inactivityUnit: 'days',
  },
};

interface RuleFormData {
  name: string;
  type: RuleType;
  params: RuleParams;
  isActive: boolean;
}

// Separate component for geo restriction to handle country selection
function GeoRestrictionInput({
  params,
  onChange,
}: {
  params: { mode?: 'blocklist' | 'allowlist'; countries?: string[]; blockedCountries?: string[] };
  onChange: (params: RuleParams) => void;
}) {
  const { t } = useTranslation('pages');
  // Handle backwards compatibility
  const mode = params.mode ?? 'blocklist';
  const countries = params.countries ?? params.blockedCountries ?? [];

  const handleModeChange = (newMode: 'blocklist' | 'allowlist') => {
    onChange({ mode: newMode, countries });
  };

  const handleCountriesChange = (newCountries: string[]) => {
    onChange({ mode, countries: newCountries });
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label>{t('rules.mode')}</Label>
        <Select
          value={mode}
          onValueChange={(v) => handleModeChange(v as 'blocklist' | 'allowlist')}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="blocklist">{t('rules.blocklist')}</SelectItem>
            <SelectItem value="allowlist">{t('rules.allowlist')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label>
          {mode === 'blocklist' ? t('rules.blockedCountries') : t('rules.allowedCountries')}
        </Label>
        <CountryMultiSelect
          value={countries}
          onChange={handleCountriesChange}
          placeholder={
            mode === 'blocklist'
              ? t('rules.selectCountriesToBlock')
              : t('rules.selectAllowedCountries')
          }
        />
        <p className="text-muted-foreground text-xs">
          {mode === 'allowlist' && t('rules.allowlistNote')}
        </p>
      </div>
    </div>
  );
}

/** Shared toggle for excluding local/private network IPs from rule evaluation */
function ExcludePrivateIpsToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation('pages');
  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="space-y-0.5">
        <Label htmlFor="excludePrivateIps" className="text-sm font-medium">
          {t('rules.excludeLocalNetwork')}
        </Label>
        <p className="text-muted-foreground text-xs">{t('rules.excludeLocalNetworkDesc')}</p>
      </div>
      <Switch id="excludePrivateIps" checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function RuleParamsForm({
  type,
  params,
  onChange,
  unitSystem,
}: {
  type: RuleType;
  params: RuleParams;
  onChange: (params: RuleParams) => void;
  unitSystem: UnitSystem;
}) {
  const { t } = useTranslation('pages');
  const speedUnit = getSpeedUnit(unitSystem);
  const distanceUnit = getDistanceUnit(unitSystem);
  const excludePrivateIps = (params as { excludePrivateIps?: boolean }).excludePrivateIps ?? false;

  switch (type) {
    case 'impossible_travel': {
      // Convert metric value to display value
      const displayValue = Math.round(
        fromMetricDistance((params as { maxSpeedKmh: number }).maxSpeedKmh, unitSystem)
      );
      const defaultDisplay = Math.round(fromMetricDistance(500, unitSystem));
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxSpeedKmh">{t('rules.maxSpeed', { unit: speedUnit })}</Label>
            <NumericInput
              id="maxSpeedKmh"
              min={0}
              value={displayValue}
              onChange={(inputValue) => {
                // Convert display value back to metric for storage
                const metricValue = Math.round(toMetricDistance(inputValue, unitSystem));
                onChange({ ...params, maxSpeedKmh: metricValue });
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t('rules.maxSpeedDefault', { value: defaultDisplay, unit: speedUnit })}
            </p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'simultaneous_locations': {
      // Convert metric value to display value
      const displayValue = Math.round(
        fromMetricDistance((params as { minDistanceKm: number }).minDistanceKm, unitSystem)
      );
      const defaultDisplay = Math.round(fromMetricDistance(100, unitSystem));
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="minDistanceKm">{t('rules.minDistance', { unit: distanceUnit })}</Label>
            <NumericInput
              id="minDistanceKm"
              min={0}
              value={displayValue}
              onChange={(inputValue) => {
                // Convert display value back to metric for storage
                const metricValue = Math.round(toMetricDistance(inputValue, unitSystem));
                onChange({ ...params, minDistanceKm: metricValue });
              }}
            />
            <p className="text-muted-foreground text-xs">
              {t('rules.minDistanceDefault', { value: defaultDisplay, unit: distanceUnit })}
            </p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'device_velocity': {
      const groupByDevice = (params as { groupByDevice?: boolean }).groupByDevice ?? false;
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxIps">{t('rules.maxIps')}</Label>
            <NumericInput
              id="maxIps"
              min={1}
              value={(params as { maxIps: number; windowHours: number }).maxIps}
              onChange={(value) => {
                onChange({ ...params, maxIps: value });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="windowHours">{t('rules.timeWindow')}</Label>
            <NumericInput
              id="windowHours"
              min={1}
              value={(params as { maxIps: number; windowHours: number }).windowHours}
              onChange={(value) => {
                onChange({ ...params, windowHours: value });
              }}
            />
          </div>
          <p className="text-muted-foreground text-xs">{t('rules.maxIpsDefault')}</p>
          <div className="flex items-center justify-between rounded-lg border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="groupByDevice" className="text-sm font-medium">
                {t('rules.groupByDevice')}
              </Label>
              <p className="text-muted-foreground text-xs">{t('rules.groupByDeviceDesc')}</p>
            </div>
            <Switch
              id="groupByDevice"
              checked={groupByDevice}
              onCheckedChange={(checked) => onChange({ ...params, groupByDevice: checked })}
            />
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    }
    case 'concurrent_streams':
      return (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="maxStreams">{t('rules.maxStreams')}</Label>
            <NumericInput
              id="maxStreams"
              min={1}
              value={(params as { maxStreams: number }).maxStreams}
              onChange={(value) => {
                onChange({ ...params, maxStreams: value });
              }}
            />
            <p className="text-muted-foreground text-xs">{t('rules.maxStreamsDefault')}</p>
          </div>
          <ExcludePrivateIpsToggle
            checked={excludePrivateIps}
            onCheckedChange={(checked) => onChange({ ...params, excludePrivateIps: checked })}
          />
        </div>
      );
    case 'geo_restriction':
      return (
        <GeoRestrictionInput
          params={
            params as {
              mode?: 'blocklist' | 'allowlist';
              countries?: string[];
              blockedCountries?: string[];
            }
          }
          onChange={onChange}
        />
      );
    case 'account_inactivity': {
      const inactivityParams = params as {
        inactivityValue: number;
        inactivityUnit: 'days' | 'weeks' | 'months';
      };
      return (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="inactivityValue">{t('rules.inactivityPeriod')}</Label>
              <NumericInput
                id="inactivityValue"
                min={1}
                value={inactivityParams.inactivityValue}
                onChange={(value) => {
                  onChange({ ...params, inactivityValue: value });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inactivityUnit">{t('rules.unit')}</Label>
              <Select
                value={inactivityParams.inactivityUnit}
                onValueChange={(v) => {
                  onChange({ ...params, inactivityUnit: v as 'days' | 'weeks' | 'months' });
                }}
              >
                <SelectTrigger id="inactivityUnit">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="days">{t('rules.days')}</SelectItem>
                  <SelectItem value="weeks">{t('rules.weeks')}</SelectItem>
                  <SelectItem value="months">{t('rules.months')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <p className="text-muted-foreground text-xs">{t('rules.inactivityNote')}</p>
        </div>
      );
    }
    default:
      return null;
  }
}

function RuleDialog({
  rule,
  onSave,
  onClose,
  isLoading,
  unitSystem,
}: {
  rule?: Rule;
  onSave: (data: RuleFormData) => void;
  onClose: () => void;
  isLoading?: boolean;
  unitSystem: UnitSystem;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const ruleTypes = useRuleTypes();
  const isEditing = !!rule;
  const [formData, setFormData] = useState<RuleFormData>({
    name: rule?.name ?? '',
    type: rule?.type ?? 'concurrent_streams',
    params: rule?.params ?? DEFAULT_PARAMS['concurrent_streams'],
    isActive: rule?.isActive ?? true,
  });

  const handleTypeChange = (type: RuleType) => {
    setFormData({
      ...formData,
      type,
      params: DEFAULT_PARAMS[type],
    });
  };

  const handleSubmit = (e: React.SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t('pages:rules.ruleName')}</Label>
        <Input
          id="name"
          value={formData.name}
          onChange={(e) => {
            setFormData({ ...formData, name: e.target.value });
          }}
          placeholder={t('pages:rules.ruleNamePlaceholder')}
          required
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="type">{t('pages:rules.ruleType')}</Label>
        <Select
          value={formData.type}
          onValueChange={(value) => {
            handleTypeChange(value as RuleType);
          }}
          disabled={isEditing}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ruleTypes.map((type) => (
              <SelectItem key={type.value} value={type.value}>
                <div className="flex items-center gap-2">
                  {type.icon}
                  {type.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-muted-foreground text-xs">
          {ruleTypes.find((t) => t.value === formData.type)?.description}
        </p>
      </div>

      <RuleParamsForm
        type={formData.type}
        params={formData.params}
        onChange={(params) => {
          setFormData({ ...formData, params });
        }}
        unitSystem={unitSystem}
      />

      <div className="flex items-center justify-between">
        <Label htmlFor="isActive">{t('common:labels.active')}</Label>
        <Switch
          id="isActive"
          checked={formData.isActive}
          onCheckedChange={(checked) => {
            setFormData({ ...formData, isActive: checked });
          }}
        />
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" disabled={isLoading || !formData.name}>
          {isLoading
            ? t('common:states.saving')
            : isEditing
              ? t('pages:rules.updateRule')
              : t('pages:rules.createRule')}
        </Button>
      </DialogFooter>
    </form>
  );
}

function RuleCard({
  rule,
  onEdit,
  onDelete,
  onToggle,
  unitSystem,
  isSelected,
  onSelect,
  filterOptions,
}: {
  rule: Rule;
  onEdit: () => void;
  onDelete: () => void;
  onToggle: () => void;
  unitSystem: UnitSystem;
  isSelected?: boolean;
  onSelect?: () => void;
  filterOptions?: RulesFilterOptions;
}) {
  const { t } = useTranslation('pages');
  const ruleTypes = useRuleTypes();
  const ruleType = ruleTypes.find((rt) => rt.value === rule.type);
  const speedUnit = getSpeedUnit(unitSystem);
  const distanceUnit = getDistanceUnit(unitSystem);
  const isV2 = isV2Rule(rule);

  // Get icon: V2 rules infer from first condition, V1 uses type mapping
  const icon = isV2
    ? getRuleIcon(rule)
    : ((rule.type ? RULE_TYPE_ICONS[rule.type] : null) ?? <Shield className="h-5 w-5" />);

  // Get subtitle: V2 shows summary, V1 shows type label
  const subtitle = isV2
    ? getRuleSummary(rule, filterOptions)
    : (ruleType?.label ?? rule.type?.replace(/_/g, ' ') ?? 'Unknown');

  return (
    <Card
      className={`${!rule.isActive ? 'opacity-60' : ''} ${isSelected ? 'ring-primary ring-2' : ''}`}
    >
      <CardContent className="pt-6">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-4">
            {onSelect && (
              <Checkbox
                checked={isSelected}
                onCheckedChange={onSelect}
                aria-label={`Select ${rule.name}`}
              />
            )}
            <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
              {icon}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{rule.name}</h3>
                {!rule.isActive && (
                  <span className="text-muted-foreground text-xs">({t('rules.disable')}d)</span>
                )}
              </div>
              {isV2 && rule.description && (
                <p className="text-muted-foreground text-sm">{rule.description}</p>
              )}
              <p className="text-muted-foreground text-sm">{subtitle}</p>
              {/* V1 rules: show parameter details */}
              {!isV2 && (
                <div className="text-muted-foreground mt-2 text-xs">
                  {rule.type === 'impossible_travel' && (
                    <span>
                      {t('rules.maxSpeed', { unit: speedUnit })}:{' '}
                      {Math.round(
                        fromMetricDistance(
                          (rule.params as { maxSpeedKmh: number }).maxSpeedKmh,
                          unitSystem
                        )
                      )}{' '}
                      {speedUnit}
                    </span>
                  )}
                  {rule.type === 'simultaneous_locations' && (
                    <span>
                      {t('rules.minDistance', { unit: distanceUnit })}:{' '}
                      {Math.round(
                        fromMetricDistance(
                          (rule.params as { minDistanceKm: number }).minDistanceKm,
                          unitSystem
                        )
                      )}{' '}
                      {distanceUnit}
                    </span>
                  )}
                  {rule.type === 'device_velocity' && (
                    <span>
                      {t('rules.maxIps')}:{' '}
                      {(rule.params as { maxIps: number; windowHours: number }).maxIps} /{' '}
                      {(rule.params as { maxIps: number; windowHours: number }).windowHours}h
                    </span>
                  )}
                  {rule.type === 'concurrent_streams' && (
                    <span>
                      {t('rules.maxStreams')}: {(rule.params as { maxStreams: number }).maxStreams}
                    </span>
                  )}
                  {rule.type === 'geo_restriction' &&
                    (() => {
                      const p = rule.params as {
                        mode?: string;
                        countries?: string[];
                        blockedCountries?: string[];
                      };
                      const mode = p.mode ?? 'blocklist';
                      const countries = p.countries ?? p.blockedCountries ?? [];
                      const countryNames = countries.map((c) => getCountryName(c) ?? c);
                      return (
                        <span>
                          {mode === 'allowlist' ? t('rules.allowed') : t('rules.blocked')}:{' '}
                          {countryNames.join(', ') || t('rules.none')}
                        </span>
                      );
                    })()}
                  {rule.type === 'account_inactivity' &&
                    (() => {
                      const p = rule.params as {
                        inactivityValue: number;
                        inactivityUnit: string;
                      };
                      return (
                        <span>
                          {t('rules.inactiveFor', {
                            value: p.inactivityValue,
                            unit: p.inactivityUnit,
                          })}
                        </span>
                      );
                    })()}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch checked={rule.isActive} onCheckedChange={onToggle} />
            <Button variant="ghost" size="icon" onClick={onEdit}>
              <Pencil className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" onClick={onDelete}>
              <Trash2 className="text-destructive h-4 w-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function Rules() {
  const { t } = useTranslation(['pages', 'common']);
  const { data: rules, isLoading } = useRules();
  const { data: settings } = useSettings();
  const createRule = useCreateRule();
  const updateRule = useUpdateRule();
  const deleteRule = useDeleteRule();
  const toggleRule = useToggleRule();
  const bulkToggleRules = useBulkToggleRules();
  const bulkDeleteRules = useBulkDeleteRules();

  const unitSystem = settings?.unitSystem ?? 'metric';

  // V1 Classic rule dialog state (for editing legacy rules only)
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingRule, setEditingRule] = useState<Rule | undefined>();
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);

  // Template picker for creating new rules from classic templates
  const [isTemplatePicker, setIsTemplatePicker] = useState(false);

  // V2 Custom rule builder dialog state
  const [isV2DialogOpen, setIsV2DialogOpen] = useState(false);
  const [editingV2Rule, setEditingV2Rule] = useState<Rule | undefined>();
  const [selectedTemplate, setSelectedTemplate] = useState<ClassicRuleTemplate | undefined>();
  const createRuleV2 = useCreateRuleV2();
  const updateRuleV2 = useUpdateRuleV2();
  const { data: rulesFilterOptions } = useRulesFilterOptions();

  // Row selection for bulk operations
  const { selectedIds, selectedCount, toggleRow, clearSelection, isSelected } = useRowSelection({
    getRowId: (rule: Rule) => rule.id,
    totalCount: rules?.length ?? 0,
  });

  const handleCreate = (data: RuleFormData) => {
    createRule.mutate(
      {
        name: data.name,
        type: data.type,
        params: data.params,
        isActive: data.isActive,
        serverUserId: null,
      },
      {
        onSuccess: () => {
          setIsDialogOpen(false);
          setEditingRule(undefined);
        },
      }
    );
  };

  const handleUpdate = (data: RuleFormData) => {
    if (!editingRule) return;
    updateRule.mutate(
      {
        id: editingRule.id,
        data: {
          name: data.name,
          params: data.params,
          isActive: data.isActive,
        },
      },
      {
        onSuccess: () => {
          setIsDialogOpen(false);
          setEditingRule(undefined);
        },
      }
    );
  };

  const handleDelete = (id: string) => {
    deleteRule.mutate(id, {
      onSuccess: () => {
        setDeleteConfirmId(null);
      },
    });
  };

  const handleToggle = (rule: Rule) => {
    toggleRule.mutate({ id: rule.id, isActive: !rule.isActive });
  };

  const handleBulkEnable = () => {
    bulkToggleRules.mutate(
      { ids: Array.from(selectedIds), isActive: true },
      { onSuccess: clearSelection }
    );
  };

  const handleBulkDisable = () => {
    bulkToggleRules.mutate(
      { ids: Array.from(selectedIds), isActive: false },
      { onSuccess: clearSelection }
    );
  };

  const handleBulkDelete = () => {
    bulkDeleteRules.mutate(Array.from(selectedIds), {
      onSuccess: () => {
        clearSelection();
        setBulkDeleteConfirmOpen(false);
      },
    });
  };

  // Legacy V1 rule editing (for backwards compatibility)
  const openEditDialog = (rule: Rule) => {
    setEditingRule(rule);
    setIsDialogOpen(true);
  };

  // Template picker for classic rules
  const openTemplatePicker = () => {
    setIsTemplatePicker(true);
  };

  const handleTemplateSelect = (template: ClassicRuleTemplate) => {
    setSelectedTemplate(template);
    setIsTemplatePicker(false);
    setEditingV2Rule(undefined);
    setIsV2DialogOpen(true);
  };

  // V2 Custom rule handlers
  const openV2CreateDialog = () => {
    setSelectedTemplate(undefined);
    setEditingV2Rule(undefined);
    setIsV2DialogOpen(true);
  };

  const openV2EditDialog = (rule: Rule) => {
    setSelectedTemplate(undefined);
    setEditingV2Rule(rule);
    setIsV2DialogOpen(true);
  };

  const handleV2Save = async (data: CreateRuleV2Input | UpdateRuleV2Input) => {
    if (editingV2Rule) {
      await updateRuleV2.mutateAsync({ id: editingV2Rule.id, data });
    } else {
      await createRuleV2.mutateAsync(data as CreateRuleV2Input);
    }
    setIsV2DialogOpen(false);
    setEditingV2Rule(undefined);
  };

  const bulkActions: BulkAction[] = [
    {
      key: 'enable',
      label: t('pages:rules.enable'),
      icon: <Power className="h-4 w-4" />,
      variant: 'default',
      onClick: handleBulkEnable,
      isLoading: bulkToggleRules.isPending,
    },
    {
      key: 'disable',
      label: t('pages:rules.disable'),
      icon: <PowerOff className="h-4 w-4" />,
      variant: 'secondary',
      onClick: handleBulkDisable,
      isLoading: bulkToggleRules.isPending,
    },
    {
      key: 'delete',
      label: t('common:actions.delete'),
      icon: <Trash2 className="h-4 w-4" />,
      variant: 'destructive',
      onClick: () => setBulkDeleteConfirmOpen(true),
      isLoading: bulkDeleteRules.isPending,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold">{t('pages:rules.title')}</h1>
          <p className="text-muted-foreground">{t('pages:rules.description')}</p>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              {t('pages:rules.addRule')}
              <ChevronDown className="ml-2 h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={openTemplatePicker}>
              <Settings2 className="mr-2 h-4 w-4" />
              Classic Rule
            </DropdownMenuItem>
            <DropdownMenuItem onClick={openV2CreateDialog}>
              <Sparkles className="mr-2 h-4 w-4" />
              Custom Rule
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {editingRule ? t('pages:rules.editRule') : t('pages:rules.createRule')}
              </DialogTitle>
              <DialogDescription>
                {editingRule
                  ? t('pages:rules.updateDescription')
                  : t('pages:rules.createDescription')}
              </DialogDescription>
            </DialogHeader>
            <RuleDialog
              rule={editingRule}
              onSave={editingRule ? handleUpdate : handleCreate}
              onClose={() => {
                setIsDialogOpen(false);
              }}
              isLoading={createRule.isPending || updateRule.isPending}
              unitSystem={unitSystem}
            />
          </DialogContent>
        </Dialog>
      </div>

      {isLoading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <Card key={i}>
              <CardContent className="pt-6">
                <div className="flex items-start gap-4">
                  <Skeleton className="h-10 w-10 rounded-lg" />
                  <div className="space-y-2">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-4 w-24" />
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : !rules || rules.length === 0 ? (
        <Card>
          <CardContent className="flex h-64 flex-col items-center justify-center gap-4">
            <Shield className="text-muted-foreground h-12 w-12" />
            <div className="text-center">
              <h3 className="font-semibold">{t('pages:rules.noRulesConfigured')}</h3>
              <p className="text-muted-foreground text-sm">{t('pages:rules.createFirstRule')}</p>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button>
                  <Plus className="mr-2 h-4 w-4" />
                  {t('pages:rules.addRule')}
                  <ChevronDown className="ml-2 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onClick={openTemplatePicker}>
                  <Settings2 className="mr-2 h-4 w-4" />
                  Classic Rule
                </DropdownMenuItem>
                <DropdownMenuItem onClick={openV2CreateDialog}>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Custom Rule
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {rules.map((rule) => (
            <RuleCard
              key={rule.id}
              rule={rule}
              onEdit={() => {
                // Route to appropriate editor based on rule version
                if (isV2Rule(rule)) {
                  openV2EditDialog(rule);
                } else {
                  openEditDialog(rule);
                }
              }}
              onDelete={() => {
                setDeleteConfirmId(rule.id);
              }}
              onToggle={() => {
                handleToggle(rule);
              }}
              unitSystem={unitSystem}
              isSelected={isSelected(rule)}
              onSelect={() => toggleRow(rule)}
              filterOptions={rulesFilterOptions}
            />
          ))}
        </div>
      )}

      {/* Bulk Actions Toolbar */}
      <BulkActionsToolbar
        selectedCount={selectedCount}
        actions={bulkActions}
        onClearSelection={clearSelection}
      />

      {/* Bulk Delete Confirmation */}
      <ConfirmDialog
        open={bulkDeleteConfirmOpen}
        onOpenChange={setBulkDeleteConfirmOpen}
        title={t('pages:rules.deleteRule', { count: selectedCount })}
        description={t('pages:rules.deleteRulesConfirm')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={handleBulkDelete}
        isLoading={bulkDeleteRules.isPending}
      />

      <ConfirmDialog
        open={!!deleteConfirmId}
        onOpenChange={() => {
          setDeleteConfirmId(null);
        }}
        title={t('pages:rules.deleteRule')}
        description={t('pages:rules.deleteRuleConfirm')}
        confirmLabel={t('common:actions.delete')}
        onConfirm={() => deleteConfirmId && handleDelete(deleteConfirmId)}
        isLoading={deleteRule.isPending}
      />

      {/* Template Picker Dialog */}
      <Dialog open={isTemplatePicker} onOpenChange={setIsTemplatePicker}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Choose a Rule Template</DialogTitle>
            <DialogDescription>
              Select a pre-configured rule type to get started quickly.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {CLASSIC_RULE_TEMPLATES.map((template) => (
              <button
                key={template.type}
                onClick={() => handleTemplateSelect(template)}
                className="hover:bg-accent flex items-center gap-4 rounded-lg border p-4 text-left transition-colors"
              >
                <div className="bg-muted flex h-10 w-10 shrink-0 items-center justify-center rounded-lg">
                  {RULE_TYPE_ICONS[template.type]}
                </div>
                <div>
                  <div className="font-medium">{template.label}</div>
                  <div className="text-muted-foreground text-sm">{template.description}</div>
                </div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* V2 Custom Rule Builder Dialog */}
      <RuleBuilderDialog
        open={isV2DialogOpen}
        onOpenChange={(open) => {
          setIsV2DialogOpen(open);
          if (!open) setSelectedTemplate(undefined);
        }}
        rule={
          editingV2Rule ??
          (selectedTemplate
            ? {
                id: '',
                name: selectedTemplate.defaultName,
                description: selectedTemplate.description,
                isActive: true,
                conditions: selectedTemplate.conditions,
                actions: selectedTemplate.actions,
              }
            : undefined)
        }
        onSave={handleV2Save}
        isLoading={createRuleV2.isPending || updateRuleV2.isPending}
        filterOptions={rulesFilterOptions}
      />
    </div>
  );
}
