/**
 * Application root and routing.
 *
 * Two experiences share one shell:
 *   /app/*   the resident and caregiver interface
 *   /admin/* the administration CMS
 *
 * Route guards mirror the server's permission table. They exist to avoid
 * showing someone a page they cannot use - the API is what actually enforces
 * access, and it re-checks every request independently.
 */

import * as React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

import { useSession } from '@/store/session';
import { useLiveStore } from '@/store/live';
import { TooltipProvider } from '@/components/ui';
import { ToastProvider } from '@/components/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { StaticDemoBanner } from '@/components/StaticDemoBanner';
import { canAccessAdmin } from '@shared/domain/permissions';

import LoginPage from '@/pages/LoginPage';
import { AppLayout } from '@/layouts/AppLayout';
import { AdminLayout } from '@/layouts/AdminLayout';

// User-facing pages
import DashboardPage from '@/pages/app/DashboardPage';
import MonitorPage from '@/pages/app/MonitorPage';
import PredictPage from '@/pages/app/PredictPage';
import GuidePage from '@/pages/app/GuidePage';
import HeatMapPage from '@/pages/app/HeatMapPage';
import CaregiverPage from '@/pages/app/CaregiverPage';
import DevicesPage from '@/pages/app/DevicesPage';
import SettingsPage from '@/pages/app/SettingsPage';
import PrivacyPage from '@/pages/app/PrivacyPage';

// Admin pages
import AdminDashboard from '@/pages/admin/AdminDashboard';
import AdminUsers from '@/pages/admin/AdminUsers';
import AdminUserDetail from '@/pages/admin/AdminUserDetail';
import AdminCaregivers from '@/pages/admin/AdminCaregivers';
import AdminDevices from '@/pages/admin/AdminDevices';
import AdminSensors from '@/pages/admin/AdminSensors';
import AdminRiskRules from '@/pages/admin/AdminRiskRules';
import AdminActionRules from '@/pages/admin/AdminActionRules';
import AdminHeatMap from '@/pages/admin/AdminHeatMap';
import AdminCoolingSpaces from '@/pages/admin/AdminCoolingSpaces';
import AdminAlerts from '@/pages/admin/AdminAlerts';
import AdminNotifications from '@/pages/admin/AdminNotifications';
import AdminContent from '@/pages/admin/AdminContent';
import AdminDataSources from '@/pages/admin/AdminDataSources';
import AdminSystem from '@/pages/admin/AdminSystem';
import AdminAuditLog from '@/pages/admin/AdminAuditLog';

function FullPageLoader({ label = '載入中…' }: { label?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <Loader2 className="size-7 animate-spin text-primary" />
        <p className="text-sm">{label}</p>
      </div>
    </div>
  );
}

/** Requires any signed-in account. */
function RequireAuth({ children }: { children: React.ReactNode }) {
  const { account, loading } = useSession();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!account) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

/**
 * Requires a role permitted into the CMS.
 *
 * An ELDER account reaching /admin is redirected to their own dashboard
 * rather than shown a permission error, which would be a dead end for
 * someone who has no route forward from it.
 */
function RequireAdmin({ children }: { children: React.ReactNode }) {
  const { account, loading } = useSession();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (!account) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  if (!canAccessAdmin(account.role)) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

export default function App() {
  const restore = useSession((s) => s.restore);
  const loading = useSession((s) => s.loading);
  const account = useSession((s) => s.account);

  const connect = useLiveStore((s) => s.connect);
  const disconnect = useLiveStore((s) => s.disconnect);

  React.useEffect(() => {
    void restore();
  }, [restore]);

  // The live socket runs only while signed in; there is nothing to show
  // before that, and an anonymous socket would just be wasted work.
  React.useEffect(() => {
    if (!account) return;
    connect();
    return () => disconnect();
  }, [account, connect, disconnect]);

  if (loading) return <FullPageLoader label="正在載入平台…" />;

  return (
    <TooltipProvider delayDuration={300}>
      <ToastProvider>
        <a href="#main-content" className="skip-link">
          跳至主要內容
        </a>

        <StaticDemoBanner />

        <ErrorBoundary>
          <Routes>
            <Route path="/login" element={<LoginPage />} />

            {/* ---------------- Resident & caregiver ---------------- */}
            <Route
              path="/app"
              element={
                <RequireAuth>
                  <AppLayout />
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="monitor" element={<MonitorPage />} />
              <Route path="predict" element={<PredictPage />} />
              <Route path="guide" element={<GuidePage />} />
              <Route path="heat-map" element={<HeatMapPage />} />
              <Route path="caregiver" element={<CaregiverPage />} />
              <Route path="devices" element={<DevicesPage />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="privacy" element={<PrivacyPage />} />
            </Route>

            {/* ---------------------- Admin CMS --------------------- */}
            <Route
              path="/admin"
              element={
                <RequireAdmin>
                  <AdminLayout />
                </RequireAdmin>
              }
            >
              <Route index element={<AdminDashboard />} />
              <Route path="users" element={<AdminUsers />} />
              <Route path="users/:id" element={<AdminUserDetail />} />
              <Route path="caregivers" element={<AdminCaregivers />} />
              <Route path="devices" element={<AdminDevices />} />
              <Route path="sensors" element={<AdminSensors />} />
              <Route path="risk-rules" element={<AdminRiskRules />} />
              <Route path="action-rules" element={<AdminActionRules />} />
              <Route path="heat-map" element={<AdminHeatMap />} />
              <Route path="cooling-spaces" element={<AdminCoolingSpaces />} />
              <Route path="alerts" element={<AdminAlerts />} />
              <Route path="notifications" element={<AdminNotifications />} />
              <Route path="content" element={<AdminContent />} />
              <Route path="data-sources" element={<AdminDataSources />} />
              <Route path="system" element={<AdminSystem />} />
              <Route path="audit-log" element={<AdminAuditLog />} />
            </Route>

            <Route path="/" element={<Navigate to={account ? '/app' : '/login'} replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </ErrorBoundary>
      </ToastProvider>
    </TooltipProvider>
  );
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <p className="text-6xl font-bold text-muted-foreground/40">404</p>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">找不到這個頁面</h1>
        <p className="text-sm text-muted-foreground">您要找的頁面可能已移動或不存在。</p>
      </div>
      <a
        href="/app"
        className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
      >
        回到首頁
      </a>
    </div>
  );
}
