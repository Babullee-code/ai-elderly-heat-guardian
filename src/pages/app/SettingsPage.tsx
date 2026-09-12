/**
 * 設定 - notification inbox, display preferences and account.
 *
 * Profile editing is deliberately absent: resident records are maintained by
 * platform administrators, and offering a disabled form here would be worse
 * than saying so plainly.
 */

import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Bell,
  BellOff,
  CheckCheck,
  ChevronRight,
  Eye,
  Info,
  LogOut,
  Mail,
  MessageSquare,
  Phone,
  Shield,
  Smartphone,
  Type,
  User,
} from 'lucide-react';

import type { ElderlyUser, NotificationChannel, PersonalBaseline } from '@shared/types/domain';
import { ROLE_LABELS } from '@shared/domain/permissions';
import { api, ApiError } from '@/lib/api';
import { useLiveStore, selectUserDevices } from '@/store/live';
import { useSession } from '@/store/session';
import { CHANNEL_ZH, cn, formatDateTime, initials, timeAgo } from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Label,
  Separator,
  Skeleton,
  Switch,
} from '@/components/ui';
import { PageHeader } from '@/components/domain/Cards';
import { EmptyState } from '@/components/domain/RiskIndicators';

const CHANNEL_ICONS: Record<NotificationChannel, React.ComponentType<{ className?: string }>> = {
  PUSH: Bell,
  SMS: MessageSquare,
  EMAIL: Mail,
  IN_APP: Smartphone,
  VOICE_CALL: Phone,
};

export default function SettingsPage() {
  const toast = useToast();
  const navigate = useNavigate();

  const { account, elderMode, setElderMode, logout } = useSession();
  const focusUserId = useSession((s) => s.focusUserId());

  const notifications = useLiveStore((s) => s.notifications);
  const devices = useLiveStore(selectUserDevices(focusUserId));

  const [user, setUser] = React.useState<ElderlyUser | null>(null);
  const [baseline, setBaseline] = React.useState<PersonalBaseline | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!focusUserId) {
      setLoading(false);
      return;
    }
    api
      .getUser(focusUserId)
      .then((detail) => {
        setUser(detail.user);
        setBaseline(detail.baseline);
      })
      .catch(() => {
        // The rest of the page still works without the profile block.
      })
      .finally(() => setLoading(false));
  }, [focusUserId]);

  const unread = notifications.filter((n) => !n.read);

  const markRead = async (id: string) => {
    try {
      await api.markNotificationRead(id);
    } catch (error) {
      toast.error('無法標記為已讀', error instanceof ApiError ? error.displayMessage : '請稍後再試。');
    }
  };

  const markAllRead = async () => {
    setBusy(true);
    try {
      const result = await api.markAllNotificationsRead();
      toast.success(`已標記 ${result.markedRead} 則通知為已讀`);
    } catch (error) {
      toast.error('操作失敗', error instanceof ApiError ? error.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="space-y-6">
      <PageHeader title="設定" description="通知、顯示方式與帳號資訊。" />

      {/* ------------------------- Notifications --------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
                <Bell className="size-4 text-primary" />
              </span>
              <div>
                <CardTitle className="text-base">通知紀錄</CardTitle>
                <CardDescription className="text-xs">
                  {unread.length > 0 ? `${unread.length} 則未讀` : '沒有未讀通知'}
                </CardDescription>
              </div>
            </div>

            {unread.length > 0 && (
              <Button size="sm" variant="outline" onClick={markAllRead} loading={busy}>
                <CheckCheck />
                全部標為已讀
              </Button>
            )}
          </div>
        </CardHeader>

        <CardContent>
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <BellOff className="size-6 text-muted-foreground" />
              <p className="text-sm text-muted-foreground">目前沒有通知紀錄。</p>
            </div>
          ) : (
            <ul className="max-h-[28rem] space-y-2 overflow-y-auto">
              {notifications.slice(0, 40).map((notification) => {
                const Icon = CHANNEL_ICONS[notification.channel] ?? Bell;

                return (
                  <li
                    key={notification.id}
                    className={cn(
                      'flex gap-3 rounded-lg border p-3 transition-colors',
                      notification.read
                        ? 'border-border bg-card'
                        : 'border-primary/30 bg-primary-muted/40',
                    )}
                  >
                    <span
                      className={cn(
                        'flex size-8 shrink-0 items-center justify-center rounded-lg',
                        notification.read
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-primary text-primary-foreground',
                      )}
                    >
                      <Icon className="size-4" />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className={cn('text-sm', !notification.read && 'font-semibold')}>
                          {notification.title}
                        </p>
                        <Badge variant="muted" className="text-[10px]">
                          {CHANNEL_ZH[notification.channel] ?? notification.channel}
                        </Badge>
                      </div>

                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        {notification.body}
                      </p>

                      <div className="mt-1.5 flex flex-wrap items-center gap-3">
                        <span className="text-[11px] text-muted-foreground">
                          {timeAgo(notification.createdAt)} · 收件者 {notification.recipientName}
                        </span>
                        {!notification.read && (
                          <button
                            type="button"
                            onClick={() => void markRead(notification.id)}
                            className="text-[11px] font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            標為已讀
                          </button>
                        )}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---------------------- Display preferences ------------------------ */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <Type className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className="text-base">顯示方式</CardTitle>
              <CardDescription className="text-xs">調整介面的文字與按鈕大小。</CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <div className="flex items-start justify-between gap-4 rounded-lg bg-muted p-4">
            <div>
              <Label htmlFor="elder-mode-setting" className="text-base">
                高齡友善模式
              </Label>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                放大文字與按鈕、簡化畫面，只保留最重要的資訊：目前狀態、現在該做什麼、家人是否知道，以及求助。
              </p>
            </div>
            <Switch
              id="elder-mode-setting"
              checked={elderMode}
              onCheckedChange={(value) => {
                setElderMode(value);
                toast.success(value ? '已開啟高齡友善模式' : '已關閉高齡友善模式');
              }}
              aria-label="切換高齡友善模式"
            />
          </div>
        </CardContent>
      </Card>

      {/* ---------------------------- Profile ------------------------------ */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <User className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className="text-base">個人資料</CardTitle>
              <CardDescription className="text-xs">
                這些資料由平台管理者維護，如需修改請聯繫照護團隊。
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-5 w-48" />
              <Skeleton className="h-5 w-64" />
            </div>
          ) : user ? (
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
              <Row label="姓名" value={user.name} />
              <Row label="年齡" value={`${user.age} 歲`} />
              <Row label="居住地區" value={`${user.city} ${user.district}`} />
              <Row label="聯絡電話" value={user.phone} />
              <Row
                label="慢性病史"
                value={user.conditions.length > 0 ? user.conditions.join('、') : '無紀錄'}
              />
              <Row
                label="用藥"
                value={user.medications.length > 0 ? user.medications.join('、') : '無紀錄'}
              />
              <Row
                label="緊急聯絡人"
                value={`${user.emergencyContact.name}（${user.emergencyContact.relationship}）${user.emergencyContact.phone}`}
              />
              {baseline && (
                <Row
                  label="個人心率基準"
                  value={`${baseline.heartRate.min}–${baseline.heartRate.max} BPM（由 ${baseline.sampleCount} 筆休息量測學習）`}
                />
              )}
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">無法載入個人資料。</p>
          )}
        </CardContent>
      </Card>

      {/* -------------------------- Quick links ---------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <LinkCard
          to="/app/devices"
          icon={Smartphone}
          title="我的裝置"
          description={`${devices.length} 台裝置已登記`}
        />
        <LinkCard
          to="/app/privacy"
          icon={Shield}
          title="隱私與資料"
          description="查看收集了哪些資料、誰可以看到，以及調整授權"
        />
      </div>

      {/* ---------------------------- Account ------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">帳號</CardTitle>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <span
              className="flex size-11 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ backgroundColor: account?.avatarColor ?? '#0d9488' }}
            >
              {initials(account?.nameZh ?? '?')}
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{account?.nameZh}</p>
              <p className="truncate text-xs text-muted-foreground">{account?.email}</p>
            </div>
            {account && <Badge variant="secondary">{ROLE_LABELS[account.role].labelZh}</Badge>}
          </div>

          <Separator />

          <Button variant="outline" onClick={handleLogout} className="w-full sm:w-auto">
            <LogOut />
            登出
          </Button>
        </CardContent>
      </Card>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            本原型的所有感測數值皆為模擬資料，並未連接真實裝置。示範帳號沒有密碼，僅供競賽展示使用。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{value}</dd>
    </div>
  );
}

function LinkCard({
  to,
  icon: Icon,
  title,
  description,
}: {
  to: string;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  description: string;
}) {
  return (
    <Card className="transition-shadow hover:shadow-card-hover">
      <Link
        to={to}
        className="flex items-center gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
          <Icon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{title}</p>
          <p className="truncate text-xs text-muted-foreground">{description}</p>
        </div>
        <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </Card>
  );
}
