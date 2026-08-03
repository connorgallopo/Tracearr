import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { Login } from '@/pages/Login';
import { PlexCallback } from '@/pages/PlexCallback';
import { Setup } from '@/pages/Setup';
import { Dashboard } from '@/pages/Dashboard';
import { Map } from '@/pages/Map';
import {
  StatsActivity,
  StatsOverview,
  StatsUsers,
  StatsDevices,
  StatsBandwidth,
} from '@/pages/stats';
import { LibraryQuality, LibraryStorage, LibraryWatch } from '@/pages/library';
import { MediaOverview } from '@/pages/media/Overview';
import { MediaGrid } from '@/pages/media/Grid';
import { MediaGenres } from '@/pages/media/Genres';
import { MediaDetail } from '@/pages/media/Detail';
import { Users } from '@/pages/Users';
import { UserDetail } from '@/pages/UserDetail';
import { Rules } from '@/pages/Rules';
import { Violations } from '@/pages/Violations';
import { ViolationDetail } from '@/pages/ViolationDetail';
import { History } from '@/pages/History';
import { Settings } from '@/pages/Settings';
import { Debug } from '@/pages/Debug';
import { NotFound } from '@/pages/NotFound';
import { Maintenance } from '@/pages/Maintenance';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';

// Lazy load ApiDocs so Scalar's reference bundle stays out of the app startup path
const ApiDocs = lazy(() => import('@/pages/ApiDocs').then((m) => ({ default: m.ApiDocs })));

export function App() {
  // Automatically update document title based on current route
  useDocumentTitle();
  const { isInMaintenance } = useMaintenanceMode();

  if (isInMaintenance) {
    return <Maintenance />;
  }

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
          <Route path="stats" element={<Navigate to="/stats/overview" replace />} />
          <Route path="stats/overview" element={<StatsOverview />} />
          <Route path="stats/activity" element={<StatsActivity />} />
          <Route path="stats/library" element={<Navigate to="/media" replace />} />
          <Route path="stats/users" element={<StatsUsers />} />

          {/* Performance routes */}
          <Route path="stats/devices" element={<StatsDevices />} />
          <Route path="stats/bandwidth" element={<StatsBandwidth />} />

          {/* Library routes - overview merged into Media, other pages untouched */}
          <Route path="library" element={<Navigate to="/media" replace />} />
          <Route path="library/quality" element={<LibraryQuality />} />
          <Route path="library/storage" element={<LibraryStorage />} />
          <Route path="library/watch" element={<LibraryWatch />} />

          {/* Media routes */}
          <Route path="media" element={<MediaOverview />} />
          <Route path="media/browse" element={<MediaGrid />} />
          <Route path="media/movies" element={<Navigate to="/media/browse" replace />} />
          <Route path="media/shows" element={<Navigate to="/media/browse?type=shows" replace />} />
          <Route path="media/genres" element={<MediaGenres />} />
          <Route path="media/:id" element={<MediaDetail />} />

          {/* Other routes */}
          <Route path="history/:sessionId?" element={<History />} />
          <Route path="users" element={<Users />} />
          <Route path="users/:id" element={<UserDetail />} />
          <Route path="rules" element={<Rules />} />
          <Route path="violations" element={<Violations />} />
          <Route path="violations/:id" element={<ViolationDetail />} />
          <Route path="settings/*" element={<Settings />} />
          <Route
            path="api-docs"
            element={
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                  </div>
                }
              >
                <ApiDocs />
              </Suspense>
            }
          />

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
