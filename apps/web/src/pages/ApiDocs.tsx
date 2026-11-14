/**
 * /public/docs requires the public API key, so the specs are fetched with it
 * and passed to Scalar as content instead of as urls.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { ApiReferenceReact } from '@scalar/api-reference-react';
import '@scalar/api-reference-react/style.css';
import { BASE_PATH } from '@/lib/basePath';
import { Button } from '@/components/ui/button';
import { useTheme } from '@/components/theme-provider';
import { useApiKey } from '@/hooks/queries/useSettings';
import './ApiDocs.css';

const API_BASE = import.meta.env.VITE_API_URL || BASE_PATH;

type OpenApiDocument = Record<string, unknown>;

// Deliberately not the api client: /public/docs authenticates with the
// public bearer token, not the dashboard cookie session
async function fetchSpec(version: 'v1' | 'v2', token: string): Promise<OpenApiDocument> {
  const res = await fetch(`${API_BASE}/api/${version}/public/docs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`spec fetch failed: ${res.status}`);
  return res.json() as Promise<OpenApiDocument>;
}

export function ApiDocs() {
  const { t } = useTranslation('pages');
  const { data: apiKeyData, isLoading } = useApiKey();
  const token = apiKeyData?.token;
  const { theme } = useTheme();
  const [specs, setSpecs] = useState<{ v1: OpenApiDocument; v2: OpenApiDocument } | null>(null);
  const [specError, setSpecError] = useState(false);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    Promise.all([fetchSpec('v2', token), fetchSpec('v1', token)])
      .then(([v2, v1]) => {
        if (!cancelled) setSpecs({ v1, v2 });
      })
      .catch(() => {
        if (!cancelled) setSpecError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

  const configuration = useMemo(
    () => ({
      sources: specs
        ? [
            { title: t('apiDocs.versionV2'), slug: 'v2', content: specs.v2, default: true },
            { title: t('apiDocs.versionV1'), slug: 'v1', content: specs.v1 },
          ]
        : [],
      darkMode: isDark,
      hideDarkModeToggle: true,
      hideClientButton: true,
      showDeveloperTools: 'never' as const,
      agent: { disabled: true },
      mcp: { disabled: true },
      authentication: token
        ? {
            preferredSecurityScheme: 'bearerAuth',
            securitySchemes: {
              bearerAuth: { token },
            },
          }
        : undefined,
    }),
    [specs, token, isDark, t]
  );

  // Show loading while fetching API key
  if (isLoading) {
    return (
      <div className="api-docs-wrapper flex items-center justify-center">
        <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      </div>
    );
  }

  return (
    <div className="api-docs-wrapper">
      <div className="api-docs-header flex items-center gap-2 overflow-hidden">
        <Link to="/settings">
          <Button variant="ghost" size="sm" className="gap-2">
            <ArrowLeft className="h-4 w-4" />
            {t('apiDocs.backToSettings')}
          </Button>
        </Link>
        {token && (
          <span className="text-muted-foreground text-sm">{t('apiDocs.apiKeyAutoLoaded')}</span>
        )}
        {!token && <span className="text-warning text-sm">{t('apiDocs.noApiKey')}</span>}
      </div>
      {specError && (
        <div className="text-destructive flex h-48 items-center justify-center text-sm">
          {t('apiDocs.specLoadError')}
        </div>
      )}
      {!specError && !specs && token && (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
        </div>
      )}
      {!specError && specs && <ApiReferenceReact configuration={configuration} />}
    </div>
  );
}
