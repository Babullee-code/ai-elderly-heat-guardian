/**
 * Administration shell.
 *
 * Denser than the resident interface, but built from the same tokens and the
 * same components - it should read as the back office of one product, not a
 * second application bolted on.
 *
 * The sidebar carries live counts (open alerts, high-risk residents) so an
 * administrator sees the state of the platform without navigating to it.
 */

import * as React from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  BellRing,
  BookOpen,
  Building2,
  ChevronLeft,
  Database,
  FileClock,
  Gauge,
  HeartPulse,
  LayoutDashboard,
  LogOut,
  Map,
  Menu,
  Radio,
  ScrollText,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Smartphone,
  Users,
  Workflow,
  X,
} from 'lucide-react';

import { useSession } from '@/store/session';
import { useLiveStore, selectOpenAlerts } from '@/store/live';
import { cn, initials } from '@/lib/utils';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui';
import { LiveIndicator } from '@/components/domain/RiskIndicators';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { DemoControls } from '@/components/domain/DemoControls';
import { ROLE_LABELS } from '@shared/domain/permissions';
import type { Permission } from '@shared/types/domain';

interface AdminNavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  permission: Permission;
  /** Live badge key resolved from platform stats. */
  badge?: 'alerts' | 'highRisk' | 'offlineDevices';
}

interface AdminNavGroup {
  title: string;
  items: AdminNavItem[];
}

const NAV_GROUPS: AdminNavGroup[] = [
  {
    title: '總覽',
    items: [
      { to: '/admin', label: '系統總覽', icon: LayoutDashboard, permission: 'system:read' },
      { to: '/admin/alerts', label: '警示中心', icon: AlertTriangle, permission: 'alert:read', badge: 'alerts' },
    ],
  },
  {
    title: '照護對象',
    items: [
      { to: '/admin/users', label: '長者管理', icon: Users, permission: 'user:read', badge: 'highRisk' },
      { to: '/admin/caregivers', label: '照護者管理', icon: HeartPulse, permission: 'caregiver:read' },
    ],
  },
  {
    title: '裝置與感測',
    items: [
      { to: '/admin/devices', label: '裝置管理', icon: Smartphone, permission: 'device:read', badge: 'offlineDevices' },
      { to: '/admin/sensors', label: '感測器監控', icon: Radio, permission: 'sensor:read' },
    ],
  },
  {
    title: '風險與政策',
    items: [
      { to: '/admin/risk-rules', label: '風險規則', icon: SlidersHorizontal, permission: 'risk-rule:read' },
      { to: '/admin/action-rules', label: '行動政策', icon: Workflow, permission: 'action-rule:read' },
      { to: '/admin/notifications', label: '通知中心', icon: BellRing, permission: 'notification:read' },
    ],
  },
  {
    title: '城市與空間',
    items: [
      { to: '/admin/heat-map', label: '熱風險地圖', icon: Map, permission: 'city-risk:read' },
      { to: '/admin/cooling-spaces', label: '涼適空間', icon: Building2, permission: 'cooling-space:read' },
    ],
  },
  {
    title: '內容與系統',
    items: [
      { to: '/admin/content', label: '衛教內容', icon: BookOpen, permission: 'content:read' },
      { to: '/admin/data-sources', label: '資料來源', icon: Database, permission: 'data-source:read' },
      { to: '/admin/system', label: '系統健康', icon: Server, permission: 'system:read' },
      { to: '/admin/audit-log', label: '操作紀錄', icon: FileClock, permission: 'audit:read' },
    ],
  },
];

export function AdminLayout() {
  const navigate = useNavigate();
  const { account, logout, can } = useSession();

  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const stats = useLiveStore((s) => s.stats);
  const openAlerts = useLiveStore(selectOpenAlerts);

  const [mobileOpen, setMobileOpen] = React.useState(false);

  const badgeValue = (key: AdminNavItem['badge']): number => {
    if (!stats) return 0;
    if (key === 'alerts') return openAlerts.length;
    if (key === 'highRisk') return stats.highRiskUsers;
    if (key === 'offlineDevices') return stats.offlineDevices;
    return 0;
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex h-16 shrink-0 items-center gap-2.5 border-b border-border px-5">
        <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <ShieldCheck className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold leading-tight">AI 守護高齡者</p>
          <p className="text-[11px] leading-tight text-muted-foreground">管理後台</p>
        </div>
        <button
          type="button"
          onClick={() => setMobileOpen(false)}
          className="ml-auto rounded-md p-1 text-muted-foreground hover:bg-accent lg:hidden"
          aria-label="關閉選單"
        >
          <X className="size-5" />
        </button>
      </div>

      <nav className="flex-1 space-y-5 overflow-y-auto px-3 py-4" aria-label="管理功能導覽">
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter((item) => can(item.permission));
          if (items.length === 0) return null;

          return (
            <div key={group.title}>
              <p className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {group.title}
              </p>
              <div className="space-y-0.5">
                {items.map((item) => {
                  const count = badgeValue(item.badge);
                  return (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.to === '/admin'}
                      onClick={() => setMobileOpen(false)}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                          isActive
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                        )
                      }
                    >
                      {({ isActive }) => (
                        <>
                          <item.icon className="size-4 shrink-0" />
                          <span className="truncate">{item.label}</span>
                          {item.badge && count > 0 && (
                            <span
                              className={cn(
                                'tabular ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold',
                                isActive
                                  ? 'bg-primary-foreground/20 text-primary-foreground'
                                  : item.badge === 'alerts' || item.badge === 'highRisk'
                                    ? 'bg-risk-high-bg text-risk-high'
                                    : 'bg-risk-medium-bg text-risk-medium',
                              )}
                            >
                              {count}
                            </span>
                          )}
                        </>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            </div>
          );
        })}
      </nav>

      <div className="shrink-0 border-t border-border p-3">
        <NavLink
          to="/app"
          className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <ChevronLeft className="size-4" />
          回到使用者介面
        </NavLink>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      {/* --------------------------- Desktop rail -------------------------- */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-border bg-card lg:block">
        {sidebar}
      </aside>

      {/* --------------------------- Mobile drawer ------------------------- */}
      {mobileOpen && (
        <>
          <div
            className="fixed inset-0 z-40 bg-foreground/40 backdrop-blur-sm lg:hidden"
            onClick={() => setMobileOpen(false)}
            aria-hidden
          />
          <aside className="fixed inset-y-0 left-0 z-50 w-64 border-r border-border bg-card shadow-panel lg:hidden">
            {sidebar}
          </aside>
        </>
      )}

      <div className="lg:pl-60">
        {/* ------------------------------ Header --------------------------- */}
        <header className="sticky top-0 z-30 border-b border-border bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              className="rounded-lg p-2 text-muted-foreground hover:bg-accent lg:hidden"
              aria-label="開啟選單"
            >
              <Menu className="size-5" />
            </button>

            {stats && (
              <div className="hidden items-center gap-4 text-xs md:flex">
                <span className="flex items-center gap-1.5">
                  <Users className="size-3.5 text-muted-foreground" />
                  <span className="tabular font-semibold">{stats.activeUsers}</span>
                  <span className="text-muted-foreground">位長者</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-risk-high" aria-hidden />
                  <span className="tabular font-semibold text-risk-high">{stats.highRiskUsers}</span>
                  <span className="text-muted-foreground">高風險</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full bg-risk-medium" aria-hidden />
                  <span className="tabular font-semibold text-risk-medium">
                    {stats.mediumRiskUsers}
                  </span>
                  <span className="text-muted-foreground">需注意</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <Activity className="size-3.5 text-muted-foreground" />
                  <span className="tabular font-semibold">{stats.devicesOnlinePct}%</span>
                  <span className="text-muted-foreground">裝置連線</span>
                </span>
              </div>
            )}

            <div className="ml-auto flex items-center gap-3">
              <LiveIndicator connection={connection} updates={updates} className="hidden sm:flex" />

              {can('simulation:control') && <DemoControls />}

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label="帳號選單"
                  >
                    <span
                      className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white"
                      style={{ backgroundColor: account?.avatarColor ?? '#7c3aed' }}
                    >
                      {initials(account?.nameZh ?? account?.name ?? '?')}
                    </span>
                  </button>
                </DropdownMenuTrigger>

                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuLabel>
                    <p className="text-sm font-semibold text-foreground">{account?.nameZh}</p>
                    <p className="font-normal text-muted-foreground">{account?.email}</p>
                    {account && (
                      <Badge variant="secondary" className="mt-2">
                        {ROLE_LABELS[account.role].labelZh}
                      </Badge>
                    )}
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onSelect={() => navigate('/app')}>
                    <Gauge />
                    使用者介面
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem destructive onSelect={handleLogout}>
                    <LogOut />
                    登出
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* A read-only role should know why its controls are missing rather
              than assume the interface is broken. */}
          {account?.role === 'VIEWER' && (
            <div className="flex items-center gap-2 border-t border-border bg-muted px-4 py-2 text-xs text-muted-foreground sm:px-6">
              <ScrollText className="size-3.5 shrink-0" />
              您以「檢視者」身分登入，可以瀏覽所有資料，但無法變更任何設定。
            </div>
          )}
        </header>

        <main id="main-content" className="px-4 py-6 sm:px-6">
          <ErrorBoundary area="這個管理頁面">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
