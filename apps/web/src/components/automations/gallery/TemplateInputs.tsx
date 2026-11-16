import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Automation, TemplateInput, UnitSystem } from '@tracearr/shared';
import { SentencePanel } from '@/components/automations/builder/SentencePanel';
import { useDestinations } from '@/hooks/queries/useDestinations';
import { useAutomationFilterOptions } from '@/hooks/queries/useHistory';
import { useSettings } from '@/hooks/queries/useSettings';
import { useServer } from '@/hooks/useServer';
import {
  describeAutomation,
  describeTemplate,
  isUnbound,
  type DescribeFragment,
  type DescribeRefs,
  type TemplateVersionBody,
} from '@/lib/automations';
import { TemplateSentence } from './TemplateCard';
import { TemplateInputField } from './TemplateInputField';

/**
 * An answer already given wins; anything else opens on its default, so no row is
 * ever blank. Keys the version no longer declares drop out.
 */
function initialInputValues(
  inputs: TemplateInput[],
  bound?: Record<string, unknown> | null
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const input of inputs) {
    const answered = bound?.[input.key];
    if (answered !== undefined) values[input.key] = answered;
    else if ('default' in input && input.default !== undefined) values[input.key] = input.default;
  }
  return values;
}

const serverInputKey = (inputs: TemplateInput[]): string | undefined =>
  inputs.find((input) => input.kind === 'server')?.key;

const missingInputs = (inputs: TemplateInput[], values: Record<string, unknown>): TemplateInput[] =>
  inputs.filter((input) => input.required && isUnbound(values[input.key]));

/** What the values are worth as a bound answer: an unbound one is not an answer. */
const boundInputValues = (values: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(values).filter(([, value]) => !isUnbound(value)));

/** Every name a template sentence can put in place of an id. */
export function useDescribeRefs(): { refs: DescribeRefs; unitSystem: UnitSystem } {
  const { data: settings } = useSettings();
  const { data: destinations } = useDestinations();
  const { data: filterOptions } = useAutomationFilterOptions();
  const { servers } = useServer();

  const refs = useMemo<DescribeRefs>(
    () => ({
      servers: Object.fromEntries(servers.map((server) => [server.id, server.name])),
      destinations: Object.fromEntries(
        (destinations ?? []).map((destination) => [destination.id, destination.name])
      ),
      countries: Object.fromEntries(
        (filterOptions?.countries ?? []).map((country) => [country.code, country.name])
      ),
    }),
    [servers, destinations, filterOptions]
  );

  return { refs, unitSystem: settings?.unitSystem ?? 'metric' };
}

/** One version's sentence and the names behind it, for whoever is showing that version. */
export function useTemplateBinding(
  version: TemplateVersionBody | undefined,
  values: Record<string, unknown>
): { refs: DescribeRefs; unitSystem: UnitSystem; fragments: DescribeFragment[] } {
  const { t } = useTranslation('pages');
  const { refs, unitSystem } = useDescribeRefs();
  const fragments = version ? describeTemplate(version, values, refs, t, unitSystem) : [];

  return { refs, unitSystem, fragments };
}

export interface TemplateAnswers {
  values: Record<string, unknown>;
  setValue: (input: TemplateInput, value: unknown) => void;
  submitted: boolean;
  focused: string | null;
  setFocused: (key: string | null) => void;
  refs: DescribeRefs;
  fragments: DescribeFragment[];
  /** The key of the server input, when the version has one to offer. */
  serverKey: string | undefined;
  boundServerId: string;
  /** Reveals the blanks, and answers whether every required one is filled. */
  attemptSubmit: () => boolean;
  /** The answers worth sending: an unbound one is not an answer. */
  bound: () => Record<string, unknown>;
}

/** The answers a form or a review is collecting, and everything derived from them. */
export function useTemplateAnswers(
  version: TemplateVersionBody,
  initialValues?: Record<string, unknown> | null
): TemplateAnswers {
  const [values, setValues] = useState(() => initialInputValues(version.inputs, initialValues));
  const [submitted, setSubmitted] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

  const { refs, fragments } = useTemplateBinding(version, values);
  const serverKey = serverInputKey(version.inputs);

  return {
    values,
    setValue: (input, value) => setValues((held) => ({ ...held, [input.key]: value })),
    submitted,
    focused,
    setFocused,
    refs,
    fragments,
    serverKey,
    boundServerId: String(values[serverKey ?? ''] ?? ''),
    attemptSubmit: () => {
      setSubmitted(true);
      return missingInputs(version.inputs, values).length === 0;
    },
    bound: () => boundInputValues(values),
  };
}

interface TemplateSentencePanelProps {
  fragments: readonly DescribeFragment[];
  /** Names the panel when two of them sit side by side. */
  label?: string;
  /** Lifts the clause the focused field wrote. */
  highlightKey?: string | null;
}

/** The framed sentence, filled in as far as the answers reach. */
export function TemplateSentencePanel({
  fragments,
  label,
  highlightKey,
}: TemplateSentencePanelProps) {
  return (
    <div className="space-y-1">
      {label !== undefined && <p className="text-muted-foreground text-xs">{label}</p>}
      <SentencePanel>
        <p className="text-muted-foreground text-sm leading-relaxed">
          <TemplateSentence fragments={fragments} highlightKey={highlightKey} clauses />
        </p>
      </SentencePanel>
    </div>
  );
}

/** A row that owns its own steps still says what it does, in the same words. */
export function AutomationSentencePanel({ automation }: { automation: Automation }) {
  const { t } = useTranslation('pages');
  const { refs, unitSystem } = useDescribeRefs();

  return <TemplateSentencePanel fragments={describeAutomation(automation, refs, t, unitSystem)} />;
}

interface TemplateInputRowsProps {
  version: TemplateVersionBody;
  values: Record<string, unknown>;
  onChange: (input: TemplateInput, value: unknown) => void;
  /** The server the form has bound, so an account picker knows whose accounts to offer. */
  boundServerId: string;
  /** Marks the required rows that are still blank, once the reader has tried to submit. */
  submitted: boolean;
  /** Label above the control, or left of it once the field group is wide enough. */
  orientation?: 'vertical' | 'responsive';
  /** The key of the row that has focus, or null when focus has left the fields. */
  onFocusInput?: (key: string | null) => void;
}

/** The parts the reader supplies, one row each. */
export function TemplateInputRows({
  version,
  values,
  onChange,
  boundServerId,
  submitted,
  orientation,
  onFocusInput,
}: TemplateInputRowsProps) {
  const { servers } = useServer();
  const { unitSystem } = useDescribeRefs();
  const { data: filterOptions } = useAutomationFilterOptions();

  return (
    <>
      {version.inputs.map((input) => (
        <TemplateInputField
          key={input.key}
          input={input}
          definition={version.definition}
          value={values[input.key]}
          onChange={(value) => onChange(input, value)}
          servers={servers}
          boundServerId={boundServerId}
          filterOptions={filterOptions}
          unitSystem={unitSystem}
          invalid={submitted && input.required && isUnbound(values[input.key])}
          orientation={orientation}
          onFocusInput={onFocusInput}
        />
      ))}
    </>
  );
}
