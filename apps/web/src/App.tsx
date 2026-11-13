import { lazy, Suspense } from 'react';
import {
  createBrowserRouter,
  createRoutesFromElements,
  Navigate,
  Outlet,
  Route,
  RouterProvider,
} from 'react-router';
import { Loader2 } from 'lucide-react';
import { Toaster } from '@/components/ui/sonner';
import { Layout } from '@/components/layout/Layout';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { RoleRoute } from '@/components/auth/RoleRoute';
import { RedirectWithSearch } from '@/components/RedirectWithSearch';
import { RouteError } from '@/components/RouteError';
import { useDocumentTitle } from '@/hooks/useDocumentTitle';
import { BASE_URL } from '@/lib/basePath';
import { STAFF_ROLES } from '@tracearr/shared';
import { Login } from '@/pages/Login';
import { PlexCallback } from '@/pages/PlexCallback';
import { Setup } from '@/pages/Setup';
import { Dashboard } from '@/pages/Dashboard';
import { Map } from '@/pages/Map';
import {
  StatsActivity,
  StatsPeople,
  StatsDevices,
  StatsBandwidth,
  StatsDownloads,
  StatsLayout,
} from '@/pages/stats';
import {
  LibraryGenres,
  LibraryLayout,
  LibraryQuality,
  LibraryStorage,
  LibraryWatch,
} from '@/pages/library';
import { MediaOverview } from '@/pages/media/Overview';
import { MediaGrid } from '@/pages/media/Grid';
import { MediaDetail } from '@/pages/media/Detail';
import { Users } from '@/pages/Users';
import { UserDetail } from '@/pages/UserDetail';
import { Automations } from '@/pages/Automations';
import { AutomationsLayout } from '@/pages/AutomationsLayout';
import { AutomationBuilderPage } from '@/pages/AutomationBuilderPage';
import { AutomationDetail } from '@/pages/AutomationDetail';
import { Violations } from '@/pages/Violations';
import { Requests } from '@/pages/Requests';
import { ViolationDetail } from '@/pages/ViolationDetail';
import { History } from '@/pages/History';
import { Settings } from '@/pages/Settings';
import { Debug } from '@/pages/Debug';
import { NotFound } from '@/pages/NotFound';
import { Maintenance } from '@/pages/Maintenance';
import { useMaintenanceMode } from '@/hooks/useMaintenanceMode';

// Lazy load ApiDocs so Scalar's reference bundle stays out of the app startup path
const ApiDocs = lazy(() => import('@/pages/ApiDocs').then((m) => ({ default: m.ApiDocs })));

// useDocumentTitle reads the location, so the shell that calls it has to sit inside
// the router rather than above RouterProvider.
function RootLayout() {
  useDocumentTitle();

  return (
    <>
      <Outlet />
      <Toaster />
    </>
  );
}

export const appRoutes = (
  <Route element={<RootLayout />} errorElement={<RouteError />}>
    {/* Public routes */}
    <Route path="/login" element={<Login />} />
    <Route path="/auth/plex-callback" element={<PlexCallback />} />

    {/* First run, after the owner account exists */}
    <Route
      path="/setup"
      element={
        <ProtectedRoute>
          <Setup />
        </ProtectedRoute>
      }
    />

    {/* Scalar lays itself out against the viewport, so the docs skip the app shell */}
    <Route
      path="/api-docs"
      errorElement={<RouteError />}
      element={
        <ProtectedRoute>
          <RoleRoute roles={STAFF_ROLES}>
            <Suspense
              fallback={
                <div className="flex h-svh items-center justify-center">
                  <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
                </div>
              }
            >
              <ApiDocs />
            </Suspense>
          </RoleRoute>
        </ProtectedRoute>
      }
    />

    {/* Protected routes */}
    <Route
      path="/"
      element={
        <ProtectedRoute>
          <Layout />
        </ProtectedRoute>
      }
    >
      <Route errorElement={<RouteError />}>
        <Route index element={<Dashboard />} />
        <Route path="map" element={<Map />} />

        <Route path="stats" element={<StatsLayout />}>
          <Route index element={<RedirectWithSearch to="/stats/activity" />} />
          <Route path="activity" element={<StatsActivity />} />
          <Route element={<RoleRoute roles={STAFF_ROLES} />}>
            <Route path="people" element={<StatsPeople />} />
            <Route path="devices" element={<StatsDevices />} />
            <Route path="bandwidth" element={<StatsBandwidth />} />
            <Route path="downloads" element={<StatsDownloads />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>
        <Route path="stats/me" element={<Navigate to="/?view=me" replace />} />
        <Route path="stats/library" element={<RedirectWithSearch to="/library" />} />
        <Route path="stats/users" element={<RedirectWithSearch to="/stats/people" />} />

        <Route path="library" element={<LibraryLayout />}>
          <Route index element={<MediaOverview />} />
          <Route path="genres" element={<LibraryGenres />} />
          <Route element={<RoleRoute roles={STAFF_ROLES} />}>
            <Route path="quality" element={<LibraryQuality />} />
            <Route path="storage" element={<LibraryStorage />} />
            <Route path="watch" element={<LibraryWatch />} />
          </Route>
          <Route path="*" element={<NotFound />} />
        </Route>

        <Route path="media" element={<RedirectWithSearch to="/library" />} />
        <Route path="media/genres" element={<RedirectWithSearch to="/library/genres" />} />
        <Route path="media/browse" element={<MediaGrid />} />
        <Route path="media/movies" element={<Navigate to="/media/browse" replace />} />
        <Route path="media/shows" element={<Navigate to="/media/browse?type=show" replace />} />
        <Route path="media/:id" element={<MediaDetail />} />

        {/* Other routes */}
        <Route path="history/:sessionId?" element={<History />} />
        <Route path="requests" element={<Requests />} />

        {/* Members get the same 404 a mistyped URL gets */}
        <Route element={<RoleRoute roles={STAFF_ROLES} />}>
          <Route element={<AutomationsLayout />}>
            <Route path="automations" element={<Automations />} />
            <Route path="violations" element={<Violations />} />
          </Route>
          <Route path="automations/new" element={<AutomationBuilderPage />} />
          <Route path="automations/:id" element={<AutomationDetail />} />
          <Route path="automations/:id/edit" element={<AutomationBuilderPage />} />
          <Route path="violations/:id" element={<ViolationDetail />} />
          <Route path="users" element={<Users />} />
          <Route path="users/:id" element={<UserDetail />} />
          <Route path="settings/*" element={<Settings />} />
        </Route>

        {/* Hidden debug page (owner only) */}
        <Route element={<RoleRoute roles={['owner']} />}>
          <Route path="debug" element={<Debug />} />
        </Route>

        {/* Legacy redirects */}
        <Route path="analytics" element={<Navigate to="/stats/activity" replace />} />
        <Route path="activity" element={<Navigate to="/stats/activity" replace />} />

        <Route path="*" element={<NotFound />} />
      </Route>
    </Route>
  </Route>
);

const router = createBrowserRouter(createRoutesFromElements(appRoutes), { basename: BASE_URL });

export function App() {
  const { isInMaintenance } = useMaintenanceMode();

  if (isInMaintenance) {
    return <Maintenance />;
  }

  return <RouterProvider router={router} />;
}
