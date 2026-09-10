import { useTranslation } from 'react-i18next';
import type { Server } from '@tracearr/shared';

/** Both columns hold three or four dotted numbers; a missing part reads as zero. */
function isNewer(latest: string, installed: string): boolean {
  const a = latest.split('.').map(Number);
  const b = installed.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

/**
 * A server ahead of the vendor's public feed, such as a Plex Pass build, counts as up to
 * date. A server that has never answered the update checker shows no line at all.
 */
export function ServerVersionLine({ server }: { server: Server }) {
  const { t } = useTranslation(['settings']);
  if (!server.version) return null;

  const outdated = !!server.latestVersion && isNewer(server.latestVersion, server.version);
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
