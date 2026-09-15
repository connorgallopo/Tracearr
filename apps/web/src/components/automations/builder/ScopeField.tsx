import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Combobox } from '@/components/ui/combobox';
import { ServerSelect } from '@/components/server';
import { useServer } from '@/hooks/useServer';
import { useUsers } from '@/hooks/queries/useUsers';
import {
  isScopeComplete,
  offeredScopeModes,
  withScopeMode,
  type AutomationScope,
  type AutomationScopeMode,
} from '@/lib/automations/scope';
import { StepFooterField } from './StepFooterField';

interface ScopeFieldProps {
  scope: AutomationScope;
  onChange: (scope: AutomationScope) => void;
  enforceAcrossServers: boolean;
  onEnforceAcrossServersChange: (value: boolean) => void;
  canEnforceAcrossServers: boolean;
  showErrors?: boolean;
}

export function ScopeField({
  scope,
  onChange,
  enforceAcrossServers,
  onEnforceAcrossServersChange,
  canEnforceAcrossServers,
  showErrors = false,
}: ScopeFieldProps) {
  const { t } = useTranslation('pages');
  const { servers } = useServer();
  const fieldId = useId();

  // One server needs no picking: the account roster can only come from it.
  const soleServerId = servers.length === 1 ? (servers[0]?.id ?? '') : '';
  const asksForServer = scope.mode === 'server' || (scope.mode === 'account' && !soleServerId);

  // A stored scope can name a mode this install no longer offers; keep it as the current value.
  const offered = offeredScopeModes(servers.length);
  const modes = offered.includes(scope.mode) ? offered : [scope.mode, ...offered];

  const scopeServerId = ('serverId' in scope ? scope.serverId : '') || soleServerId;

  const { data: accountsPage } = useUsers(
    { serverId: scopeServerId, pageSize: 100 },
    { enabled: scope.mode === 'account' && scopeServerId !== '' }
  );
  const { data: identitiesPage } = useUsers(
    { pageSize: 100 },
    { enabled: scope.mode === 'person' }
  );

  const accounts = accountsPage?.data ?? [];
  const identities = identitiesPage?.data ?? [];

  const handleModeChange = (mode: string) => {
    if (!mode) return;
    onChange(withScopeMode(scope, mode as AutomationScopeMode, servers[0]?.id ?? ''));
  };

  const incomplete = showErrors && !isScopeComplete(scope);

  return (
    <StepFooterField
      labelId={`${fieldId}-label`}
      label={t('automations.builder.scope.label')}
      control={
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={scope.mode}
          aria-labelledby={`${fieldId}-label`}
          onValueChange={handleModeChange}
          className="flex-wrap"
        >
          {modes.map((mode) => (
            <ToggleGroupItem key={mode} value={mode}>
              {t(`automations.builder.scope.${mode}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    >
      {scope.mode !== 'global' && (
        <FieldGroup>
          {servers.length === 0 && scope.mode !== 'person' ? (
            <FieldDescription>{t('automations.builder.scope.noServers')}</FieldDescription>
          ) : (
            <div className="grid gap-4 @md:grid-cols-2">
              {asksForServer && 'serverId' in scope && (
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-server`}>
                    {t('automations.builder.scope.serverLabel')}
                  </FieldLabel>
                  <ServerSelect
                    id={`${fieldId}-server`}
                    servers={servers}
                    value={scopeServerId}
                    placeholder={t('automations.builder.scope.serverPlaceholder')}
                    onChange={(serverId) =>
                      onChange(
                        scope.mode === 'account'
                          ? {
                              mode: 'account',
                              serverId,
                              // Re-picking the server the account already sits on keeps it.
                              serverUserId: serverId === scopeServerId ? scope.serverUserId : '',
                            }
                          : { mode: 'server', serverId }
                      )
                    }
                  />
                </Field>
              )}

              {scope.mode === 'account' && scopeServerId && (
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-account`}>
                    {t('automations.builder.scope.accountLabel')}
                  </FieldLabel>
                  <Combobox
                    id={`${fieldId}-account`}
                    value={scope.serverUserId || null}
                    options={accounts.map((account) => ({
                      value: account.id,
                      label: account.identityName ?? account.username,
                    }))}
                    onChange={(serverUserId) =>
                      onChange({ mode: 'account', serverId: scopeServerId, serverUserId })
                    }
                    placeholder={t('automations.builder.scope.accountPlaceholder')}
                    searchPlaceholder={t('automations.builder.searchPlaceholder')}
                    emptyText={t('automations.builder.noMatches')}
                  />
                </Field>
              )}

              {scope.mode === 'person' && (
                <Field>
                  <FieldLabel htmlFor={`${fieldId}-person`}>
                    {t('automations.builder.scope.personLabel')}
                  </FieldLabel>
                  <Combobox
                    id={`${fieldId}-person`}
                    value={scope.userId || null}
                    options={identities.map((identity) => ({
                      value: identity.userId,
                      label: identity.identityName ?? identity.username,
                    }))}
                    onChange={(userId) => onChange({ mode: 'person', userId })}
                    placeholder={t('automations.builder.scope.personPlaceholder')}
                    searchPlaceholder={t('automations.builder.searchPlaceholder')}
                    emptyText={t('automations.builder.noMatches')}
                  />
                  <FieldDescription>{t('automations.builder.scope.personHelper')}</FieldDescription>
                </Field>
              )}
            </div>
          )}

          {incomplete && <FieldError>{t('automations.builder.errors.scopeIncomplete')}</FieldError>}
        </FieldGroup>
      )}

      {canEnforceAcrossServers && (
        <Field orientation="horizontal">
          <Switch
            id={`${fieldId}-enforce`}
            checked={enforceAcrossServers}
            onCheckedChange={onEnforceAcrossServersChange}
          />
          <FieldContent>
            <FieldLabel htmlFor={`${fieldId}-enforce`}>
              {t('automations.builder.scope.enforceAcrossServers')}
            </FieldLabel>
            <FieldDescription className="max-w-prose">
              {t('automations.builder.scope.enforceAcrossServersDescription')}
            </FieldDescription>
          </FieldContent>
        </Field>
      )}
    </StepFooterField>
  );
}
