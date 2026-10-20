import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import type { Condition, ConditionFieldDescriptor, DeviceType } from '@tracearr/shared';
import { Checkbox } from '@/components/ui/checkbox';
import { NumericInput } from '@/components/ui/numeric-input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { fieldOptions } from '@/lib/automations';
import { FieldControl } from './FieldControl';

interface ConditionParamsProps {
  condition: Condition;
  descriptor: ConditionFieldDescriptor;
  onChange: (condition: Condition) => void;
}

/** The extras a field declares: the window it counts over and what it counts as one. */
export function ConditionParams({ condition, descriptor, onChange }: ConditionParamsProps) {
  const { t } = useTranslation('pages');
  const fieldId = useId();

  const updateParams = (params: Partial<NonNullable<Condition['params']>>) => {
    onChange({ ...condition, params: { ...condition.params, ...params } });
  };

  const setDeviceTypes = (types: string[]) => {
    const { count_device_types: _dropped, ...rest } = condition.params ?? {};
    onChange({
      ...condition,
      params:
        types.length > 0 ? { ...rest, count_device_types: types as DeviceType[] } : { ...rest },
    });
  };

  return (
    <>
      {descriptor.flags.windowHours && (
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground text-sm whitespace-nowrap">
            {t('automations.builder.conditions.windowPrefix')}
          </span>
          <NumericInput
            className="w-16"
            aria-label={t('automations.builder.conditions.windowUnit')}
            min={1}
            max={168}
            value={condition.params?.window_hours ?? 24}
            onChange={(window_hours) => updateParams({ window_hours })}
          />
          <span className="text-muted-foreground text-sm">
            {t('automations.builder.conditions.windowUnit')}
          </span>
        </div>
      )}

      {descriptor.flags.excludeSameDevice && (
        <ConditionToggle
          label={t('automations.builder.conditions.uniqueDevices')}
          hint={t('automations.builder.conditions.uniqueDevicesHint')}
          checked={condition.params?.exclude_same_device ?? true}
          onChange={(exclude_same_device) => updateParams({ exclude_same_device })}
        />
      )}

      {descriptor.flags.skipMobileSameCountry && (
        <ConditionToggle
          label={t('automations.builder.conditions.skipMobileSameCountry')}
          hint={t('automations.builder.conditions.skipMobileSameCountryHint')}
          checked={condition.params?.skip_mobile_same_country ?? true}
          onChange={(skip_mobile_same_country) => updateParams({ skip_mobile_same_country })}
        />
      )}

      {descriptor.flags.excludeSameIp && (
        <ConditionToggle
          label={t('automations.builder.conditions.uniqueIps')}
          hint={t('automations.builder.conditions.uniqueIpsHint')}
          checked={condition.params?.exclude_same_ip ?? false}
          onChange={(exclude_same_ip) => updateParams({ exclude_same_ip })}
        />
      )}

      {descriptor.flags.countDeviceTypes && (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="w-44 shrink-0">
              <FieldControl
                id={`${fieldId}-device-types`}
                spec={{
                  kind: 'multiSelect',
                  options: fieldOptions(t, 'device_type'),
                  placeholder: t('automations.builder.conditions.allDeviceTypes'),
                }}
                value={condition.params?.count_device_types ?? []}
                onChange={(types) => setDeviceTypes(types as string[])}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-60">
            {t('automations.builder.conditions.deviceTypesHint')}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}

interface ConditionToggleProps {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

function ConditionToggle({ label, hint, checked, onChange }: ConditionToggleProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <label className="flex h-9 cursor-pointer items-center gap-2 whitespace-nowrap">
          <Checkbox checked={checked} onCheckedChange={onChange} />
          <span className="text-muted-foreground text-sm">{label}</span>
        </label>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-60">
        {hint}
      </TooltipContent>
    </Tooltip>
  );
}
