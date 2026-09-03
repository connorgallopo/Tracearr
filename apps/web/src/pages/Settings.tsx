import { Navigate, Route, Routes } from 'react-router';
import { useTranslation } from 'react-i18next';
import { SettingsNav } from '@/components/settings/shell/SettingsNav';
import { SETTINGS_HOME } from '@/components/settings/shell/settings-nav-data';
import { GeneralSettings } from '@/components/settings/GeneralSettings';
import { ServerSettings } from '@/components/settings/ServerSettings';
import { AccessSettings } from '@/components/settings/AccessSettings';
import { MobileSettings } from '@/components/settings/MobileSettings';
import { TailscaleSettings } from '@/components/settings/TailscaleSettings';
import { ImportSettings } from '@/components/settings/ImportSettings';
import { JobsSettings } from '@/components/settings/JobsSettings';
import { BackupSettings } from '@/components/settings/BackupSettings';
import { Destinations } from '@/components/settings/notifications/Destinations';

export function Settings() {
  const { t } = useTranslation('settings');

  return (
    // The layout follows this container, not the viewport: the app sidebar
    // collapses to an icon rail, which changes the room Settings has.
    <div className="@container/settings space-y-6">
      <h1 className="text-3xl font-bold">{t('title')}</h1>
      <div className="grid gap-8 @3xl/settings:grid-cols-[13rem_minmax(0,1fr)]">
        <SettingsNav />
        <div className="max-w-4xl min-w-0">
          <Routes>
            <Route index element={<Navigate to={SETTINGS_HOME} replace />} />

            <Route path="general/appearance" element={<GeneralSettings />} />
            <Route path="general/locale" element={<GeneralSettings />} />
            <Route path="general/behavior" element={<GeneralSettings />} />

            <Route path="servers/connections" element={<ServerSettings />} />
            <Route path="servers/posters" element={<ServerSettings />} />
            <Route path="servers/plex-accounts" element={<ServerSettings />} />

            <Route path="notifications/destinations" element={<Destinations />} />

            <Route path="access/guest" element={<AccessSettings />} />
            <Route path="access/mobile" element={<MobileSettings />} />
            <Route path="access/remote" element={<TailscaleSettings />} />

            <Route path="data/import" element={<ImportSettings />} />
            <Route path="data/backup" element={<BackupSettings />} />
            <Route path="data/jobs" element={<JobsSettings />} />
            <Route path="data/api" element={<GeneralSettings />} />

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
            <Route path="backup" element={<Navigate to="/settings/data/backup" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
