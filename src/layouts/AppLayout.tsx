/**
 * Resident and caregiver shell.
 *
 * Desktop gets a sidebar; mobile gets bottom navigation with large touch
 * targets, because this interface is used one-handed on a phone by someone
 * who may be unwell. Elderly mode reduces navigation to the essentials.
 */

import * as React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Activity,
  Bell,
  Brain,
  Compass,
  Gauge,
  LayoutGrid,
  LogOut,
  Map,
  Settings,
  Shield,
  ShieldCheck,
  Smartphone,
  Users,
} from 'lucide-react';

import { useSession } from '@/store/session';
import { useLiveStore, selectAssessment, selectUnreadNotifications } from '@/store/live';
import { cn, initials, RISK_STYLES } from '@/lib/utils';
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
  Label,
} from '@/components/ui';
import { LiveIndicator, RiskBadge } from '@/components/domain/RiskIndicators';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { canAccessAdmin } from '@shared/domain/permissions';

interface NavItem {
  to: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Shown in elderly mode's reduced navigation. */
  essential: boolean;
  /** Hidden for accounts that are not caregivers or staff. */
  caregiverOnly?: boolean;
}

const NAV: NavItem[] = [
  { to: '/app', label: '總覽', icon: LayoutGrid, essential: true },
  { to: '/app/monitor', label: '監測', icon: Activity, essential: true },
  { to: '/app/predict', label: '預判', icon: Brain, essential: false },
  { to: '/app/guide', label: '指引', icon: Compass, essential: true },
  { to: '/app/heat-map', label: '熱風險地圖', icon: Map, essential: false },
  { to: '/app/caregiver', label: '照護儀表板', icon: Users, essential: false, caregiverOnly: true },
  { to: '/app/devices', label: '我的裝置', icon: Smartphone, essential: true },
  { to: '/app/settings', label: '設定', icon: Settings, essential: false },
];

export function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();

  const { account, elderlyUser, elderMode, setElderMode, logout } = useSession();
  const focusUserId = useSession((s) => s.focusUserId());

  const connection = useLiveStore((s) => s.connection);
  const updates = useLiveStore((s) => s.updates);
  const assessment = useLiveStore(selectAssessment(focusUserId));
  const unread = useLiveStore(selectUnreadNotifications);

  const isElder = account?.role === 'ELDER';

  const visibleNav = React.useMemo(
    () =>
      NAV.filter((item) => {
        if (item.caregiverOnly && isElder) return false;
        if (elderMode && !item.essential) return false;
        return true;
      }),
    [elderMode, isElder],
  );

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className={cn('min-h-screen bg-background', elderMode && 'elder-mode')}>
      {/* ------------------------------ Header ------------------------------ */}
      <header className="sticky top-0 z-40 border-b border-border bg-card/85 backdrop-blur supports-[backdrop-filter]:bg-card/70">
        <div className="mx-auto flex h-16 max-w-7xl items-center gap-3 px-4 sm:px-6">
          <NavLink to="/app" className="flex items-center gap-2.5" aria-label="AI 守護高齡者 首頁">
            <span className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground">
              <ShieldCheck className="size-5" />
            </span>
            <span className="hidden sm:block">
              <span className="block text-sm font-bold leading-tight">AI 守護高齡者</span>
              <span className="block text-[11px] leading-tight text-muted-foreground">
                監測 · 預判 · 指引
              </span>
            </span>
          </NavLink>

          <div className="ml-auto flex items-center gap-3">
            {assessment && (
              <NavLink to="/app" className="hidden sm:block">
                <RiskBadge level={assessment.level} size="sm" />
              </NavLink>
            )}

            <LiveIndicator connection={connection} updates={updates} className="hidden md:flex" />

            <NavLink
              to="/app/settings"
              className="relative rounded-lg p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={`通知${unread.length > 0 ? `，${unread.length} 則未讀` : ''}`}
            >
              <Bell className="size-5" />
              {unread.length > 0 && (
                <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-risk-high text-[10px] font-bold text-white">
                  {unread.length > 9 ? '9+' : unread.length}
                </span>
              )}
            </NavLink>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="flex items-center gap-2 rounded-lg p-1 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="帳號選單"
                >
                  <span
                    className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white"
                    style={{ backgroundColor: account?.avatarColor ?? '#0d9488' }}
                  >
                    {initials(account?.nameZh ?? account?.name ?? '?')}
                  </span>
                </button>
              </DropdownMenuTrigger>

              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuLabel>
                  <p className="text-sm font-semibold text-foreground">{account?.nameZh}</p>
                  <p className="font-normal text-muted-foreground">{account?.email}</p>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />

                <div className="flex items-center justify-between gap-3 px-2 py-2">
                  <Label htmlFor="elder-mode-toggle" className="cursor-pointer text-sm font-normal">
                    高齡友善模式
                  </Label>
                  <Switch
                    id="elder-mode-toggle"
                    checked={elderMode}
                    onCheckedChange={setElderMode}
                    aria-label="切換高齡友善模式"
                  />
                </div>
                <p className="px-2 pb-2 text-[11px] leading-relaxed text-muted-foreground">
                  放大文字與按鈕，並簡化畫面。
                </p>

                <DropdownMenuSeparator />

                <DropdownMenuItem onSelect={() => navigate('/app/privacy')}>
                  <Shield />
                  隱私與資料
                </DropdownMenuItem>

                {account && canAccessAdmin(account.role) && (
                  <DropdownMenuItem onSelect={() => navigate('/admin')}>
                    <Gauge />
                    管理後台
                  </DropdownMenuItem>
                )}

                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={handleLogout}>
                  <LogOut />
                  登出
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6">
        {/* ----------------------- Desktop sidebar ----------------------- */}
        <nav
          className="hidden w-56 shrink-0 lg:block"
          aria-label="主要導覽"
        >
          <div className="sticky top-24 space-y-1">
            {visibleNav.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/app'}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    isActive
                      ? 'bg-primary text-primary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                    elderMode && 'py-4 text-lg',
                  )
                }
              >
                <item.icon className={cn('size-5 shrink-0', elderMode && 'size-6')} />
                {item.label}
              </NavLink>
            ))}

            {elderlyUser && (
              <div className="mt-6 rounded-xl border border-border bg-card p-4">
                <p className="text-xs font-medium text-muted-foreground">目前檢視</p>
                <p className="mt-1 font-semibold">{elderlyUser.name}</p>
                <p className="text-xs text-muted-foreground">
                  {elderlyUser.age} 歲 · {elderlyUser.district}
                </p>
                {assessment && (
                  <p className={cn('mt-2 text-xs font-medium', RISK_STYLES[assessment.level].text)}>
                    {RISK_STYLES[assessment.level].plainZh}
                  </p>
                )}
              </div>
            )}
          </div>
        </nav>

        {/* -------------------------- Main content ------------------------- */}
        <main
          id="main-content"
          className="min-w-0 flex-1 pb-24 lg:pb-0"
          key={location.pathname}
        >
          <ErrorBoundary area="這個頁面">
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      {/* ---------------------- Mobile bottom navigation ------------------- */}
      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur lg:hidden"
        aria-label="主要導覽"
      >
        <div
          className="mx-auto grid max-w-lg"
          style={{ gridTemplateColumns: `repeat(${Math.min(visibleNav.length, 5)}, minmax(0, 1fr))` }}
        >
          {visibleNav.slice(0, 5).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/app'}
              className={({ isActive }) =>
                cn(
                  // 64px tall: comfortably above the 44px minimum touch target.
                  'flex min-h-16 flex-col items-center justify-center gap-1 px-1 py-2 text-[11px] font-medium transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  isActive ? 'text-primary' : 'text-muted-foreground',
                  elderMode && 'min-h-20 text-sm',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <item.icon
                    className={cn('size-5', elderMode && 'size-7', isActive && 'stroke-[2.5]')}
                  />
                  <span className="truncate">{item.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </div>
        {/* Safe-area padding for devices with a home indicator. */}
        <div className="h-[env(safe-area-inset-bottom)]" />
      </nav>
    </div>
  );
}
