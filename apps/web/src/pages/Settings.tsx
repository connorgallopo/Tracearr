import { Navigate, Route, Routes, useLocation } from 'react-router';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { SettingsNav } from '@/components/settings/shell/SettingsNav';
import { BACKUP_HREF, SETTINGS_HOME } from '@/components/settings/shell/settings-nav-data';
import { Appearance } from '@/components/settings/general/Appearance';
import { Locale } from '@/components/settings/general/Locale';
import { Behavior } from '@/components/settings/general/Behavior';
import { Import } from '@/components/settings/data/Import';
import { Api } from '@/components/settings/data/Api';
import { Connections } from '@/components/settings/servers/Connections';
import { PosterSource } from '@/components/settings/servers/PosterSource';
import { PlexAccounts } from '@/components/settings/servers/PlexAccounts';
import { Guest } from '@/components/settings/access/Guest';
import { MobileDevices } from '@/components/settings/access/MobileDevices';
import { RemoteAccess } from '@/components/settings/access/RemoteAccess';
import { Jobs } from '@/components/settings/data/Jobs';
import { Backup } from '@/components/settings/data/Backup';
import { Destinations } from '@/components/settings/notifications/Destinations';
import { Email } from '@/components/settings/notifications/Email';
import { Newsletters } from '@/components/settings/notifications/Newsletters';
import { NewsletterEditor } from '@/components/settings/notifications/newsletter/NewsletterEditor';

const WIDE_SECTIONS = new Set([BACKUP_HREF]);

export function Settings() {
  const { t } = useTranslation('settings');
  const { pathname } = useLocation();

  return (
    // Layout follows this container, not the viewport: the app sidebar collapses to an icon rail.
    <div className="@container/settings space-y-6">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <div className="grid gap-8 @3xl/settings:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav />
        <div className={cn('min-w-0', WIDE_SECTIONS.has(pathname) ? 'max-w-6xl' : 'max-w-4xl')}>
          <Routes>
            <Route index element={<Navigate to={SETTINGS_HOME} replace />} />

            <Route path="general/appearance" element={<Appearance />} />
            <Route path="general/locale" element={<Locale />} />
            <Route path="general/behavior" element={<Behavior />} />

            <Route path="servers/connections" element={<Connections />} />
            <Route path="servers/posters" element={<PosterSource />} />
            <Route path="servers/plex-accounts" element={<PlexAccounts />} />

            <Route path="notifications/destinations" element={<Destinations />} />
            <Route path="notifications/newsletters" element={<Newsletters />} />
            <Route path="notifications/newsletters/new" element={<NewsletterEditor />} />
            <Route path="notifications/newsletters/:id" element={<NewsletterEditor />} />
            <Route path="notifications/email" element={<Email />} />

            <Route path="access/guest" element={<Guest />} />
            <Route path="access/mobile" element={<MobileDevices />} />
            <Route path="access/remote" element={<RemoteAccess />} />

            <Route path="data/import" element={<Import />} />
            <Route path="data/backup" element={<Backup />} />
            <Route path="data/jobs" element={<Jobs />} />
            <Route path="data/api" element={<Api />} />

            <Route
              path="servers"
              element={<Navigate to="/settings/servers/connections" replace />}
            />
            <Route
              path="notifications"
              element={<Navigate to="/settings/notifications/destinations" replace />}
            />
            <Route path="access" element={<Navigate to="/settings/access/guest" replace />} />
            <Route path="mobile" element={<Navigate to="/settings/access/mobile" replace />} />
            <Route path="tailscale" element={<Navigate to="/settings/access/remote" replace />} />
            <Route path="import" element={<Navigate to="/settings/data/import" replace />} />
            <Route path="jobs" element={<Navigate to="/settings/data/jobs" replace />} />
            <Route path="backup" element={<Navigate to={BACKUP_HREF} replace />} />

            <Route path="*" element={<Navigate to={SETTINGS_HOME} replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
