/**
 * 隱私與資料 - the privacy centre.
 *
 * Two principles shape this page:
 *
 * 1. Every consent switch states what turning it OFF actually costs. A switch
 *    that quietly degrades the service is a dark pattern; one that says "the
 *    air conditioner will no longer switch itself on for you" is an informed
 *    choice.
 * 2. The switches are real. They write to the resident's permissions, which
 *    the policy engine consults on every tick, so the consequence is
 *    immediate and visible on the dashboard.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AirVent,
  AlertTriangle,
  Bell,
  Building2,
  CheckCircle2,
  Database,
  Eye,
  Heart,
  Info,
  Lock,
  MapPin,
  Shield,
  Thermometer,
  Users,
} from 'lucide-react';

import type { Caregiver, ElderlyUser, UserPermissions } from '@shared/types/domain';
import { ROLE_LABELS } from '@shared/domain/permissions';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/store/session';
import { cn, RELATIONSHIP_ZH } from '@/lib/utils';
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

interface ConsentSpec {
  key: keyof UserPermissions;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  what: string;
  /** Stated plainly: what the resident gives up by switching this off. */
  cost: string;
}

const CONSENTS: ConsentSpec[] = [
  {
    key: 'automaticCooling',
    label: '允許系統自動開啟降溫設備',
    icon: AirVent,
    what: '當熱風險升高時，系統可以自動開啟您家中的冷氣或除濕機。',
    cost: '關閉後，系統不會再為您開啟任何降溫設備。畫面上仍會提醒您該降溫，並註明「未執行：使用者尚未授權」，需要您自己動手開啟。',
  },
  {
    key: 'caregiverNotifications',
    label: '允許通知家人或照護者',
    icon: Bell,
    what: '風險升高時，系統會將您的狀況通知指派的家人或照護人員。',
    cost: '關閉後，家人不會收到任何自動通知。即使風險升到高風險，也只有您自己會看到提醒。',
  },
  {
    key: 'locationSharing',
    label: '分享概略位置',
    icon: MapPin,
    what: '用來計算您與附近涼適空間的距離，並排序最適合前往的地點。',
    cost: '關閉後，系統無法建議附近的涼適空間，「指引」頁面的地點推薦會停止顯示。',
  },
  {
    key: 'physiologicalDataStorage',
    label: '儲存生理資料以學習個人基準',
    icon: Heart,
    what: '保存心率、體表溫度與活動量，用來學習您平常的休息數值範圍。',
    cost: '關閉後，系統無法學習您的個人基準，只能改用一般性的參考值判讀，對您個人的準確度會明顯下降。',
  },
  {
    key: 'cityDataContribution',
    label: '提供匿名資料給城市熱風險統計',
    icon: Building2,
    what: '以行政區為單位的匿名彙總，協助城市掌握哪些區域的高齡者風險較高。',
    cost: '關閉後，您的資料不會納入城市統計。這不影響您個人使用系統的任何功能。',
  },
];

const DATA_CATEGORIES = [
  {
    icon: Thermometer,
    title: '居家環境資料',
    items: ['室內溫度', '室內濕度', '室外溫度與濕度', '空氣品質指數'],
    purpose: '計算熱指數，判斷您所處環境的熱負荷。',
  },
  {
    icon: Heart,
    title: '穿戴裝置資料',
    items: ['心率', '體表溫度', '每小時活動量'],
    purpose: '與您個人的平常範圍比對，判斷身體是否出現偏離。',
  },
  {
    icon: Activity,
    title: '風險事件紀錄',
    items: ['風險等級變化', '當時的判讀依據', '系統執行的動作'],
    purpose: '供您與照護者回顧，也是系統改進判讀準確度的依據。',
  },
  {
    icon: Bell,
    title: '通知紀錄',
    items: ['發送時間', '接收對象', '通知內容'],
    purpose: '確認家人確實收到了提醒，並留下可追溯的紀錄。',
  },
  {
    icon: Database,
    title: '裝置狀態',
    items: ['連線狀態', '電量', '訊號強度', '韌體版本'],
    purpose: '確保感測資料可信，並在裝置離線時明確告知您。',
  },
];

export default function PrivacyPage() {
  const toast = useToast();
  const focusUserId = useSession((s) => s.focusUserId());
  const elderMode = useSession((s) => s.elderMode);

  const [user, setUser] = React.useState<ElderlyUser | null>(null);
  const [caregivers, setCaregivers] = React.useState<Caregiver[]>([]);
  const [retentionDays, setRetentionDays] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [savingKey, setSavingKey] = React.useState<keyof UserPermissions | null>(null);

  const load = React.useCallback(async () => {
    if (!focusUserId) {
      setLoading(false);
      return;
    }
    setError(null);
    try {
      const detail = await api.getUser(focusUserId);
      setUser(detail.user);
      setCaregivers(detail.caregivers);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入隱私設定。');
    } finally {
      setLoading(false);
    }

    // Retention is a platform setting; residents may not be able to read it,
    // and that is not an error worth showing them.
    try {
      const settings = await api.listSettings();
      setRetentionDays(
        settings.settings.find((s) => s.key === 'privacy.retentionDays')?.value ?? null,
      );
    } catch {
      setRetentionDays(null);
    }
  }, [focusUserId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (spec: ConsentSpec, value: boolean) => {
    if (!focusUserId || !user) return;
    setSavingKey(spec.key);

    // Optimistic, so the switch responds immediately; reverted on failure.
    const previous = user.permissions;
    setUser({ ...user, permissions: { ...previous, [spec.key]: value } });

    try {
      const result = await api.updateUserPermissions(focusUserId, { [spec.key]: value });
      setUser(result.user);

      toast.success(
        value ? `已開啟「${spec.label}」` : `已關閉「${spec.label}」`,
        value ? '這項功能現在可以正常運作。' : spec.cost,
      );
    } catch (err) {
      setUser({ ...user, permissions: previous });
      toast.error('設定未變更', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setSavingKey(null);
    }
  };

  if (!focusUserId) {
    return (
      <div className="space-y-6">
        <PageHeader title="隱私與資料" />
        <EmptyState icon={Shield} title="尚未選擇長者" description="目前的帳號沒有對應的長者資料。" />
      </div>
    );
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="隱私與資料" description="載入中…" />
        <Skeleton className="h-64" />
        <Skeleton className="h-80" />
      </div>
    );
  }

  if (error || !user) {
    return (
      <div className="space-y-6">
        <PageHeader title="隱私與資料" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入隱私設定"
          description={error ?? '資料不可用。'}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="隱私與資料"
        description="您可以隨時查看系統收集了哪些資料、誰能看到，以及調整每一項授權。"
      />

      {/* --------------------------- Consents ----------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <Shield className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className={elderMode ? 'text-xl' : 'text-base'}>您的授權</CardTitle>
              <CardDescription className="text-xs">
                每一項都可以隨時開啟或關閉，變更會立即生效。
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {CONSENTS.map((spec) => {
            const enabled = user.permissions[spec.key];
            const Icon = spec.icon;

            return (
              <div
                key={spec.key}
                className={cn(
                  'rounded-lg border p-4 transition-colors',
                  enabled ? 'border-border bg-card' : 'border-dashed border-border bg-muted/40',
                )}
              >
                <div className="flex items-start gap-3">
                  <span
                    className={cn(
                      'flex size-9 shrink-0 items-center justify-center rounded-lg',
                      enabled ? 'bg-primary-muted text-primary' : 'bg-muted text-muted-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>

                  <div className="min-w-0 flex-1">
                    <Label
                      htmlFor={`consent-${spec.key}`}
                      className={cn('cursor-pointer', elderMode ? 'text-lg' : 'text-sm')}
                    >
                      {spec.label}
                    </Label>
                    <p
                      className={cn(
                        'mt-1 leading-relaxed text-muted-foreground',
                        elderMode ? 'text-base' : 'text-xs',
                      )}
                    >
                      {spec.what}
                    </p>

                    {/* The cost of switching off is always visible, not only
                        revealed after the fact. */}
                    <p
                      className={cn(
                        'mt-2 rounded-md p-2.5 leading-relaxed',
                        enabled
                          ? 'bg-muted text-muted-foreground'
                          : 'bg-risk-medium-bg text-risk-medium',
                        elderMode ? 'text-sm' : 'text-xs',
                      )}
                    >
                      <strong className="font-medium">關閉後：</strong>
                      {spec.cost}
                    </p>
                  </div>

                  <Switch
                    id={`consent-${spec.key}`}
                    checked={enabled}
                    disabled={savingKey === spec.key}
                    onCheckedChange={(value) => void toggle(spec, value)}
                    aria-label={spec.label}
                  />
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* ------------------------ What is collected ----------------------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <Database className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className={elderMode ? 'text-xl' : 'text-base'}>收集了哪些資料</CardTitle>
              <CardDescription className="text-xs">
                {retentionDays
                  ? `個別感測資料保留 ${retentionDays} 天後自動刪除。`
                  : '感測資料會在保留期限後自動刪除。'}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          {DATA_CATEGORIES.map((category) => (
            <div key={category.title} className="flex gap-3">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <category.icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{category.title}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  {category.items.map((item) => (
                    <Badge key={item} variant="muted" className="text-[10px]">
                      {item}
                    </Badge>
                  ))}
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                  用途：{category.purpose}
                </p>
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* --------------------------- Who sees it -------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <Eye className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className={elderMode ? 'text-xl' : 'text-base'}>誰可以看到</CardTitle>
              <CardDescription className="text-xs">
                目前有權限查看您資料的對象。
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-risk-low-bg text-risk-low">
              <CheckCircle2 className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">您本人</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                可以查看所有屬於您的資料，包含完整的歷史紀錄。
              </p>
            </div>
          </div>

          <Separator />

          <div className="flex gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary-muted text-primary">
              <Users className="size-4" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                您指派的照護者（{caregivers.length} 位）
              </p>
              {caregivers.length === 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  目前沒有指派的照護者，因此沒有人會收到您的通知。
                </p>
              ) : (
                <>
                  <ul className="mt-1.5 space-y-1">
                    {caregivers.map((caregiver) => (
                      <li key={caregiver.id} className="flex items-center gap-2 text-xs">
                        <span className="font-medium">{caregiver.name}</span>
                        <span className="text-muted-foreground">
                          {RELATIONSHIP_ZH[caregiver.relationship] ?? caregiver.relationship}
                        </span>
                        {caregiver.status === 'INACTIVE' && (
                          <Badge variant="muted" className="text-[10px]">
                            已停用
                          </Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    可以查看您的即時風險狀況與警示紀錄。如需調整指派對象，請聯繫平台管理者。
                  </p>
                </>
              )}
            </div>
          </div>

          <Separator />

          <div className="flex gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <Shield className="size-4" />
            </span>
            <div>
              <p className="text-sm font-medium">平台管理者</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {ROLE_LABELS.ADMIN.description}
                為了維運系統與處理警示，管理者可以查看您的資料。所有管理者的操作都會記錄在稽核紀錄中，包含誰、在什麼時間、做了什麼變更。
              </p>
            </div>
          </div>

          <Separator />

          {/* The single strongest privacy guarantee in the product. */}
          <div className="flex gap-3 rounded-lg border border-risk-low-border bg-risk-low-bg p-3">
            <Lock className="mt-0.5 size-4 shrink-0 text-risk-low" />
            <div>
              <p className="text-sm font-medium text-risk-low">城市熱風險地圖上看不到您</p>
              <p className="mt-1 text-xs leading-relaxed text-risk-low/90">
                公開的城市地圖只顯示「行政區」層級的彙總數據，例如該區的平均熱指數與登記人數。個人的心率、體溫或住家位置永遠不會顯示在地圖上。這項限制由系統強制執行，管理後台也無法將其開啟。
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* --------------------------- Permissions --------------------------- */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">裝置權限</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <PermissionRow
              label="讀取感測器數值"
              granted
              detail="溫度、濕度、空氣品質與穿戴裝置。"
            />
            <PermissionRow
              label="控制家電"
              granted={user.permissions.automaticCooling}
              detail="開關冷氣、除濕機與電風扇。"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">位置權限</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <PermissionRow
              label="概略位置"
              granted={user.permissions.locationSharing}
              detail={`${user.city}${user.district}，用於計算附近涼適空間的距離。`}
            />
            <PermissionRow
              label="精確定位追蹤"
              granted={false}
              detail="系統不會持續追蹤您的即時位置。"
            />
          </CardContent>
        </Card>
      </div>

      <Card className="border-dashed shadow-none">
        <CardContent className="flex items-start gap-3 p-4">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-xs leading-relaxed text-muted-foreground">
            本原型的所有感測數值皆為模擬資料。若對資料的使用方式有疑問，請透過{' '}
            <Link to="/app/settings" className="font-medium text-primary hover:underline">
              設定
            </Link>{' '}
            聯繫您的照護團隊。
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------

function PermissionRow({
  label,
  granted,
  detail,
}: {
  label: string;
  granted: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <span
        className={cn(
          'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full',
          granted ? 'bg-risk-low text-white' : 'bg-muted text-muted-foreground',
        )}
        aria-hidden
      >
        {granted ? <CheckCircle2 className="size-3.5" /> : <Lock className="size-3" />}
      </span>
      <div className="min-w-0">
        <p className="font-medium">
          {label}
          <span
            className={cn(
              'ml-2 text-xs font-normal',
              granted ? 'text-risk-low' : 'text-muted-foreground',
            )}
          >
            {granted ? '已授權' : '未授權'}
          </span>
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
