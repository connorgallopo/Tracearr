import { useTranslation } from 'react-i18next';
import type { Server } from '@tracearr/shared';

/**
 * Both versions are stored normalized, so any difference between them is an update.
 * A server that has never answered the update checker shows no line at all.
 */
export function ServerVersionLine({ server }: { server: Server }) {
  const { t } = useTranslation(['settings']);
  if (!server.version) return null;

  const outdated = !!server.latestVersion && server.latestVersion !== server.version;
  return (
    <p className="text-muted-foreground text-xs">
      {t('servers.version.installed', { version: server.version })}
      {server.latestVersion && (
        <>
          {' · '}
          {outdated ? (
            <span className="text-warning">
              {t('servers.version.updateAvailable', { version: server.latestVersion })}
            </span>
          ) : (
            <span>{t('servers.version.upToDate')}</span>
          )}
        </>
      )}
    </p>
  );
}
