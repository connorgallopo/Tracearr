import { Routes, Route, Navigate } from 'react-router';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Login } from '@/pages/Login';
import { PlexCallback } from '@/pages/PlexCallback';
import { Setup } from '@/pages/Setup';
import { Dashboard } from '@/pages/Dashboard';
import { Map } from '@/pages/Map';
import { StatsActivity, StatsUsers, StatsDevices, StatsBandwidth } from '@/pages/stats';
import { LibraryOverview, LibraryQuality, LibraryStorage, LibraryWatch } from '@/pages/library';
import { Users } from '@/pages/Users';
import { UserDetail } from '@/pages/UserDetail';
import { Rules } from '@/pages/Rules';
import { Violations } from '@/pages/Violations';
import { History } from '@/pages/History';
import { Settings } from '@/pages/Settings';
import { ApiDocs } from '@/pages/ApiDocs';
import { Debug } from '@/pages/Debug';
import { NotFound } from '@/pages/NotFound';

export function App() {
  // Automatically update document title based on current route
  useDocumentTitle();

  return (
    <>
      <Routes>
        {/* Public routes */}
        <Route path="/login" element={<Login />} />
        <Route path="/auth/plex-callback" element={<PlexCallback />} />
        <Route path="/setup" element={<Setup />} />

        {/* Protected routes */}
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Dashboard />} />
          <Route path="map" element={<Map />} />

          {/* Stats routes */}
          <Route path="stats" element={<Navigate to="/stats/activity" replace />} />
          <Route path="stats/activity" element={<StatsActivity />} />
          <Route path="stats/library" element={<Navigate to="/library" replace />} />
          <Route path="stats/users" element={<StatsUsers />} />

          {/* Performance routes */}
          <Route path="stats/devices" element={<StatsDevices />} />
          <Route path="stats/bandwidth" element={<StatsBandwidth />} />

          {/* Library routes */}
          <Route path="library" element={<LibraryOverview />} />
          <Route path="library/quality" element={<LibraryQuality />} />
          <Route path="library/storage" element={<LibraryStorage />} />
          <Route path="library/watch" element={<LibraryWatch />} />

          {/* Other routes */}
          <Route path="history" element={<History />} />
          <Route path="users" element={<Users />} />
          <Route path="users/:id" element={<UserDetail />} />
          <Route path="rules" element={<Rules />} />
          <Route path="violations" element={<Violations />} />
          <Route path="settings/*" element={<Settings />} />
          <Route path="api-docs" element={<ApiDocs />} />

          {/* Hidden debug page (owner only) */}
          <Route path="debug" element={<Debug />} />

          {/* Legacy redirects */}
          <Route path="analytics" element={<Navigate to="/stats/activity" replace />} />
          <Route path="activity" element={<Navigate to="/stats/activity" replace />} />

          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
      <Toaster />
    </>
  );
}
