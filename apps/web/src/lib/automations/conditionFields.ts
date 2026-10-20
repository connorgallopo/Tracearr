/**
 * Web presentation for the shared condition-field catalog.
 *
 * Every structural fact about a field — operators, value type, options, bounds,
 * flags — lives in CONDITION_FIELDS. This module only translates and orders.
 */

import type { PagesKey, PagesTranslations, TranslationValue } from '@tracearr/translations';
import type { TFunction } from 'i18next';
import {
  CONDITION_FIELDS,
  type ConditionField,
  type ConditionFieldDescriptor,
  type DeviceType,
  type DynamicRangeToken,
  type LibraryItemType,
  type MediaTypeEnum,
  type Operator,
  type Platform,
  type ResolutionLabel,
  type TranscodingConditionValue,
  type VideoResolution,
} from '@tracearr/shared';

/** Accessors take the caller's `pages` translator rather than opening their own. */
export type Translate = TFunction<'pages'>;

/** A `pages` key that names one string; `PagesKey` also names the groups above them. */
export type PagesTextKey = {
  [K in PagesKey]: TranslationValue<PagesTranslations, K> extends string ? K : never;
}[PagesKey];

export type FieldCategory = ConditionFieldDescriptor['category'];
export type FieldUnit = NonNullable<ConditionFieldDescriptor['unit']>;

/** Every operator the catalog declares on some field. */
const KNOWN_OPERATORS = new Set<string>(
  Object.values(CONDITION_FIELDS).flatMap((descriptor) => descriptor.operators)
);

/** Group order in the field picker. */
export const FIELD_CATEGORIES = [
  'session_behavior',
  'stream_quality',
  'user_attributes',
  'device_client',
  'network_location',
  'scope',
  'media',
] as const satisfies readonly FieldCategory[];

/** Fields whose control carries a placeholder at `fields.<field>.placeholder`. */
const PLACEHOLDER_FIELDS = [
  'user_id',
  'client_name',
  'country',
  'ip_in_range',
  'server_id',
  'library_name',
] as const satisfies readonly ConditionField[];

type PlaceholderField = (typeof PLACEHOLDER_FIELDS)[number];

function hasPlaceholder(field: ConditionField): field is PlaceholderField {
  return (PLACEHOLDER_FIELDS as readonly ConditionField[]).includes(field);
}

/**
 * A stored automation can name a field or operator this build retired
 * (library_id was removed), so every accessor a stored value reaches takes a
 * plain string and falls back to it.
 */
export function isKnownField(field: string): field is ConditionField {
  return field in CONDITION_FIELDS;
}

export function isKnownOperator(operator: string): operator is Operator {
  return KNOWN_OPERATORS.has(operator);
}

/** The catalog entry for a stored field name; undefined once a field retires. */
export function fieldDescriptor(field: string): ConditionFieldDescriptor | undefined {
  return isKnownField(field) ? CONDITION_FIELDS[field] : undefined;
}

export function fieldLabel(t: Translate, field: string): string {
  return isKnownField(field) ? t(`automations.fields.${field}.label`) : field;
}

export function fieldDescription(t: Translate, field: ConditionField): string {
  return t(`automations.fields.${field}.description`);
}

export function fieldPlaceholder(t: Translate, field: ConditionField): string | undefined {
  return hasPlaceholder(field) ? t(`automations.fields.${field}.placeholder`) : undefined;
}

export function categoryLabel(t: Translate, category: FieldCategory): string {
  return t(`automations.categories.${category}`);
}

export function operatorLabel(t: Translate, operator: string): string {
  return isKnownOperator(operator) ? t(`automations.operators.${operator}`) : operator;
}

/** Every value an enum condition field stores under the flat option namespace. */
export type FieldOptionValue =
  | VideoResolution
  | DeviceType
  | Platform
  | MediaTypeEnum
  | TranscodingConditionValue
  | DynamicRangeToken
  | ResolutionLabel;

/** Display text for one of an enum field's stored option values. */
export function optionLabel(t: Translate, value: FieldOptionValue): string {
  return t(`automations.options.${value}`);
}

/**
 * Library item types read their own labels: the flat namespace speaks the session
 * vocabulary, where a track is "Music" and an episode is "TV Episode".
 */
function itemTypeLabel(t: Translate, value: LibraryItemType): string {
  return t(`automations.options.libraryItemType.${value}`);
}

export function unitLabel(t: Translate, unit: FieldUnit): string {
  return t(`automations.units.${unit}`);
}

/** The picker's options for an enum field, in catalog order. */
export function fieldOptions(t: Translate, field: string): { value: string; label: string }[] {
  const options = fieldDescriptor(field)?.options ?? [];
  if (field === 'library_item_type') {
    const types = options as readonly LibraryItemType[];
    return types.map((value) => ({ value, label: itemTypeLabel(t, value) }));
  }
  return (options as readonly FieldOptionValue[]).map((value) => ({
    value,
    label: optionLabel(t, value),
  }));
}

export function fieldsByCategory(): Record<FieldCategory, ConditionField[]> {
  const grouped: Record<FieldCategory, ConditionField[]> = {
    session_behavior: [],
    stream_quality: [],
    user_attributes: [],
    device_client: [],
    network_location: [],
    scope: [],
    media: [],
  };

  for (const field of Object.keys(CONDITION_FIELDS) as ConditionField[]) {
    grouped[CONDITION_FIELDS[field].category].push(field);
  }

  return grouped;
}

/** Whether an operator takes a list rather than a single value. */
export function isArrayOperator(operator: Operator): boolean {
  return operator === 'in' || operator === 'not_in';
}

export function getDefaultValueForField(
  field: ConditionField
): string | number | boolean | string[] {
  const descriptor = CONDITION_FIELDS[field];

  switch (descriptor.valueType) {
    case 'number':
      return descriptor.min ?? 0;
    case 'boolean':
      return true;
    case 'multiSelect':
      return [];
    case 'select':
      return descriptor.options?.[0] ?? '';
    default:
      return '';
  }
}

export function getDefaultOperatorForField(field: ConditionField): Operator {
  const { valueType, operators } = CONDITION_FIELDS[field];

  // Thresholds read better as "at least"; list fields as "is one of".
  if (valueType === 'number' && operators.includes('gte')) return 'gte';
  if ((valueType === 'multiSelect' || valueType === 'select') && operators.includes('in')) {
    return 'in';
  }

  return operators[0] ?? 'eq';
}

/** The params a freshly picked field starts with, from its declared flags. */
export function defaultParamsForField(field: ConditionField): {
  window_hours?: number;
  exclude_same_device?: boolean;
  exclude_same_ip?: boolean;
  skip_mobile_same_country?: boolean;
} {
  const { flags } = CONDITION_FIELDS[field];
  return {
    ...(flags.windowHours ? { window_hours: 24 } : {}),
    ...(flags.excludeSameDevice ? { exclude_same_device: true } : {}),
    // Same-household viewing is legitimate, so this stays off unless asked for.
    ...(flags.excludeSameIp ? { exclude_same_ip: false } : {}),
    ...(flags.skipMobileSameCountry ? { skip_mobile_same_country: true } : {}),
  };
}
