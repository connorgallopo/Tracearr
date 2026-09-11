import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { AUTOMATION_KINDS, type AutomationKind, type ViolationSeverity } from '@tracearr/shared';
import { FieldDescription, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { SEVERITIES, severityLabel } from '@/lib/automations';
import { nodeDomId, type BuilderDispatch } from './builderReducer';
import { StepFooterField } from './StepFooterField';
import { BUILDER_SECTIONS } from './validation';

interface RecordAsFieldProps {
  kind: AutomationKind;
  severity: ViolationSeverity;
  dispatch: BuilderDispatch;
}

/** What a run leaves behind, asked once the reader has said what running means. */
export function RecordAsField({ kind, severity, dispatch }: RecordAsFieldProps) {
  const { t } = useTranslation('pages');
  const labelId = useId();
  const severityId = useId();

  return (
    <div id={nodeDomId(BUILDER_SECTIONS.kind)} tabIndex={-1} className="outline-none">
      <StepFooterField
        labelId={labelId}
        label={t('automations.builder.recordAs.label')}
        control={
          <>
            <ToggleGroup
              type="single"
              variant="outline"
              size="sm"
              value={kind}
              aria-labelledby={labelId}
              onValueChange={(next) => {
                if (next) dispatch({ type: 'setKind', value: next as AutomationKind });
              }}
            >
              {AUTOMATION_KINDS.map((option) => (
                <ToggleGroupItem key={option} value={option}>
                  {t(`automations.builder.recordAs.${option}`)}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>

            {kind === 'policy' && (
              <>
                <FieldLabel htmlFor={severityId} className="text-sm font-medium">
                  {t('automations.builder.severityLabel')}
                </FieldLabel>
                <Select
                  value={severity}
                  onValueChange={(value) =>
                    dispatch({ type: 'setSeverity', value: value as ViolationSeverity })
                  }
                >
                  <SelectTrigger id={severityId} size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SEVERITIES.map((option) => (
                      <SelectItem key={option} value={option}>
                        {severityLabel(t, option)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </>
            )}
          </>
        }
      >
        <FieldDescription>{t(`automations.builder.recordAs.${kind}Description`)}</FieldDescription>
      </StepFooterField>
    </div>
  );
}
