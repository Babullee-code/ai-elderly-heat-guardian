/**
 * 長者詳細資料 - the full administrative record for one resident.
 *
 * Combines the persisted record (profile, baseline, history, alerts) with the
 * live assessment from the socket, so the page keeps moving while an admin
 * reads it. Device actions here have real platform consequences and say so.
 */

import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bell,
  Brain,
  Cpu,
  Heart,
  MapPin,
  Phone,
  RefreshCw,
  Archive,
  ArchiveRestore,
  Pencil,
  Shield,
  Stethoscope,
  Trash2,
  Thermometer,
  User,
  Users,
} from 'lucide-react';

import type { UserPermissions } from '@shared/types/domain';
import { api, ApiError, type UserDetail } from '@/lib/api';
import { useLiveStore, selectAssessment, selectHistory, selectSmartHome } from '@/store/live';
import { useSession } from '@/store/session';
import {
  ALERT_STATUS_ZH,
  cn,
  DEVICE_LABELS_ZH,
  formatDateTime,
  formatPct,
  formatTemp,
  RELATIONSHIP_ZH,
  timeAgo,
} from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Separator,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import {
  ActionList,
  AIExplanationCard,
  BaselineCard,
  DeviceCard,
  PageHeader,
  SmartHomeCard,
} from '@/components/domain/Cards';
import {
  EmptyState,
  RiskBadge,
  RiskFactorList,
  RiskScoreDial,
} from '@/components/domain/RiskIndicators';
import {
  ChartCard,
  CoolingEffectivenessChart,
  EnvironmentChart,
  HeartRateChart,
  HumidityChart,
  RiskTimeline,
} from '@/components/domain/Charts';

const CONSENT_LABELS: { key: keyof UserPermissions; label: string; effect: string }[] = [
  {
    key: 'automaticCooling',
    label: '自動降溫授權',
    effect: '關閉後，平台不會為這位長者開啟降溫設備，降溫動作會標示為未執行。',
  },
  {
    key: 'caregiverNotifications',
    label: '照護者通知授權',
    effect: '關閉後，不會發送任何通知給照護者。',
  },
  {
    key: 'locationSharing',
    label: '位置分享',
    effect: '關閉後，無法提供附近涼適空間的建議。',
  },
  {
    key: 'physiologicalDataStorage',
    label: '生理資料儲存',
    effect: '關閉後，無法學習或更新個人生理基準。',
  },
  {
    key: 'cityDataContribution',
    label: '城市統計貢獻',
    effect: '關閉後，此長者的資料不納入行政區彙總。',
  },
];

export default function AdminUserDetail() {
  const { id = '' } = useParams();
  const toast = useToast();
  const can = useSession((s) => s.can);

  const liveAssessment = useLiveStore(selectAssessment(id));
  const liveSmartHome = useLiveStore(selectSmartHome(id));
  const liveHistory = useLiveStore(selectHistory(id));

  const navigate = useNavigate();
  const [detail, setDetail] = React.useState<UserDetail | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      setDetail(await api.getUser(id));
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入長者資料。');
    } finally {
      setLoading(false);
    }
  }, [id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const relearn = async () => {
    setBusy(true);
    try {
      const result = await api.relearnBaseline(id);
      toast.success(
        '個人基準已重新學習',
        `依 ${result.sampleCount} 筆量測資料，新的心率範圍為 ${result.baseline.heartRate.min}–${result.baseline.heartRate.max} BPM。`,
      );
      await load();
    } catch (err) {
      // A refusal for missing consent is a real, meaningful outcome.
      toast.error(
        '無法重新學習基準',
        err instanceof ApiError ? err.displayMessage : '請稍後再試。',
      );
    } finally {
      setBusy(false);
    }
  };

  const deviceAction = async (deviceId: string, action: string) => {
    setBusy(true);
    try {
      await api.deviceAction(deviceId, action);
      toast.success('裝置指令已送出', '此變更會立即影響風險判讀與自動降溫的可行性。');
      await load();
    } catch (err) {
      toast.error('裝置指令失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const togglePermission = async (key: keyof UserPermissions, value: boolean) => {
    if (!detail) return;
    setBusy(true);
    try {
      const result = await api.updateUserPermissions(id, { [key]: value });
      setDetail({ ...detail, user: result.user });
      toast.success(value ? '授權已開啟' : '授權已關閉', '變更會在下一個更新週期生效。');
    } catch (err) {
      toast.error('無法變更授權', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Editing a resident's details.
   *
   * The API for this has existed all along; nothing called it, so the only way
   * to correct a phone number or an address was to edit the database by hand.
   */
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState({
    name: '',
    phone: '',
    address: '',
    district: '',
    emergencyName: '',
    emergencyRelationship: '',
    emergencyPhone: '',
  });

  /** Archive / restore / erase. */
  const [confirmArchive, setConfirmArchive] = React.useState(false);
  const [confirmErase, setConfirmErase] = React.useState(false);
  const [eraseTyped, setEraseTyped] = React.useState('');

  const openEditor = () => {
    if (!detail) return;
    const u = detail.user;
    setDraft({
      name: u.name,
      phone: u.phone,
      address: u.address,
      district: u.district,
      emergencyName: u.emergencyContact.name,
      emergencyRelationship: u.emergencyContact.relationship,
      emergencyPhone: u.emergencyContact.phone,
    });
    setEditing(true);
  };

  const saveEdits = async () => {
    if (!id) return;
    setBusy(true);
    try {
      await api.updateUser(id, {
        name: draft.name,
        phone: draft.phone,
        address: draft.address,
        district: draft.district,
        emergencyContact: {
          name: draft.emergencyName,
          relationship: draft.emergencyRelationship,
          phone: draft.emergencyPhone,
        },
      });
      toast.success('已更新長者資料');
      setEditing(false);
      await load();
    } catch (err) {
      toast.error('更新失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const archive = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const result = await api.archiveUser(id);
      toast.success('已封存', result.messageZh);
      setConfirmArchive(false);
      await load();
    } catch (err) {
      toast.error('封存失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    if (!id) return;
    setBusy(true);
    try {
      const result = await api.restoreUser(id);
      toast.success('已復原', result.messageZh);
      await load();
    } catch (err) {
      toast.error('復原失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const erase = async () => {
    if (!id || !detail) return;
    setBusy(true);
    try {
      await api.deleteUser(id, eraseTyped);
      toast.success('已永久刪除', '該長者的所有資料已移除，稽核紀錄保留。');
      navigate('/admin/users');
    } catch (err) {
      toast.error('刪除失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const suspend = async () => {
    setBusy(true);
    try {
      const result = await api.suspendUser(id);
      toast.success(
        result.user.status === 'SUSPENDED' ? '已暫停此長者的監測' : '已恢復此長者的監測',
        result.user.status === 'SUSPENDED'
          ? '暫停期間不會計算風險、不會發送通知，也不會自動控制設備。'
          : '系統已重新開始監測。',
      );
      await load();
    } catch (err) {
      toast.error('操作失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------------

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-40" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="長者詳細資料"
          breadcrumb={
            <Link to="/admin/users" className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
              <ArrowLeft className="size-3.5" />
              回到長者管理
            </Link>
          }
        />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入長者資料"
          description={error ?? '找不到這位長者。'}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  const { user, baseline, devices, caregivers, riskEvents, alerts } = detail;
  const assessment = liveAssessment ?? detail.assessment;
  const smartHome = liveSmartHome ?? detail.smartHome;
  const history = liveHistory.length > 0 ? liveHistory : detail.history;

  return (
    <div className="space-y-6">
      <PageHeader
        title={user.name}
        description={`${user.age} 歲 · ${user.city}${user.district} · ${user.nameEn}`}
        breadcrumb={
          <Link
            to="/admin/users"
            className="flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="size-3.5" />
            回到長者管理
          </Link>
        }
        actions={
          <>
            {assessment && <RiskBadge level={assessment.level} size="lg" showEnglish />}
            <Badge variant={user.status === 'ACTIVE' ? 'success' : 'muted'}>
              {user.status === 'ACTIVE'
                ? '監測中'
                : user.status === 'SUSPENDED'
                  ? '已暫停'
                  : user.status === 'ARCHIVED'
                    ? '已封存'
                    : '未啟用'}
            </Badge>

            {can('user:write') && user.status !== 'ARCHIVED' && (
              <Button variant="outline" onClick={openEditor}>
                <Pencil />
                編輯資料
              </Button>
            )}

            {can('user:suspend') && user.status !== 'ARCHIVED' && (
              <Button variant="outline" onClick={suspend} loading={busy}>
                {user.status === 'SUSPENDED' ? '恢復監測' : '暫停監測'}
              </Button>
            )}

            {/*
              Archive is the ordinary way to remove someone, and it is
              reversible. Permanent erasure is only offered once they are
              already archived - a deliberate second step rather than a
              neighbouring button that does something irreversible.
            */}
            {can('user:write') && user.status !== 'ARCHIVED' && (
              <Button variant="outline" onClick={() => setConfirmArchive(true)}>
                <Archive />
                封存
              </Button>
            )}

            {can('user:write') && user.status === 'ARCHIVED' && (
              <>
                <Button variant="outline" onClick={restore} loading={busy}>
                  <ArchiveRestore />
                  復原
                </Button>
                <Button
                  variant="outline"
                  className="border-risk-high-border text-risk-high hover:bg-risk-high-bg"
                  onClick={() => {
                    setEraseTyped('');
                    setConfirmErase(true);
                  }}
                >
                  <Trash2 />
                  永久刪除
                </Button>
              </>
            )}
          </>
        }
      />

      {user.status !== 'ACTIVE' && (
        <Card className="border-risk-medium-border bg-risk-medium-bg/40">
          <CardContent className="flex items-start gap-3 p-4">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-risk-medium" />
            <p className="text-sm text-risk-medium">
              {user.status === 'ARCHIVED'
                ? '此長者已封存，不再出現於名冊與城市統計，其裝置也已釋出。歷史紀錄與稽核軌跡都完整保留，可隨時復原。'
                : '此長者目前未在監測中，因此沒有即時風險判讀。以下顯示的是最後一次記錄的資料。'}
            </p>
          </CardContent>
        </Card>
      )}

      <Tabs defaultValue="overview">
        <TabsList className="flex h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">
            <User className="size-3.5" />
            總覽
          </TabsTrigger>
          <TabsTrigger value="baseline">
            <Heart className="size-3.5" />
            生理基準
          </TabsTrigger>
          <TabsTrigger value="environment">
            <Thermometer className="size-3.5" />
            環境與風險
          </TabsTrigger>
          <TabsTrigger value="events">
            <Activity className="size-3.5" />
            風險事件
          </TabsTrigger>
          <TabsTrigger value="devices">
            <Cpu className="size-3.5" />
            裝置
          </TabsTrigger>
          <TabsTrigger value="caregivers">
            <Users className="size-3.5" />
            照護者
          </TabsTrigger>
          <TabsTrigger value="permissions">
            <Shield className="size-3.5" />
            授權與警示
          </TabsTrigger>
        </TabsList>

        {/* ---------------------------- Overview --------------------------- */}
        <TabsContent value="overview" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">基本資料</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                  <Row label="姓名" value={`${user.name}（${user.nameEn}）`} />
                  <Row label="年齡 / 性別" value={`${user.age} 歲 · ${genderZh(user.gender)}`} />
                  <Row label="居住地區" value={`${user.city} ${user.district}`} />
                  <Row label="地址" value={user.address} />
                  <Row label="電話" value={user.phone} />
                  <Row label="登記編號" value={user.id} mono />
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
                  <Row label="座標" value={`${user.lat}, ${user.lng}`} mono />
                </dl>

                {user.medications.length > 0 && (
                  <p className="mt-4 flex gap-2 rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                    <Stethoscope className="mt-0.5 size-3.5 shrink-0" />
                    部分藥物（例如利尿劑）會影響體液平衡與排汗，使個人的熱風險高於同環境中的其他人。此資訊僅供照護判斷參考，系統不會據此做出醫療建議。
                  </p>
                )}
              </CardContent>
            </Card>

            {assessment ? (
              <div className="space-y-6">
                <Card>
                  <CardContent className="flex flex-col items-center gap-6 p-6 sm:flex-row">
                    <RiskScoreDial score={assessment.score} level={assessment.level} size={140} />
                    <div className="min-w-0 flex-1 space-y-3">
                      <p className="text-lg font-semibold">{assessment.explanation.headline}</p>
                      <div className="grid grid-cols-2 gap-3 text-sm">
                        <Metric label="熱指數" value={formatTemp(assessment.heatIndex)} />
                        <Metric label="室內溫度" value={formatTemp(assessment.readings.indoorTempC)} />
                        <Metric label="室內濕度" value={formatPct(assessment.readings.indoorHumidityPct)} />
                        <Metric
                          label="心率"
                          value={`${assessment.baseline.heartRateBpm} BPM`}
                          tone={assessment.baseline.aboveBaseline ? 'high' : undefined}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        更新於 {timeAgo(assessment.timestamp)} · 每{' '}
                        {assessment.monitoringIntervalSec} 秒評估一次
                      </p>
                    </div>
                  </CardContent>
                </Card>

                <RiskFactorList factors={assessment.factors} />
              </div>
            ) : (
              <EmptyState icon={Brain} title="目前沒有即時判讀" description="此長者未在監測中。" />
            )}
          </div>

          {assessment && (
            <div className="grid gap-6 lg:grid-cols-2">
              <AIExplanationCard assessment={assessment} />
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">目前建議的行動</CardTitle>
                  <CardDescription>
                    由政策引擎產生。未執行的動作會說明原因。
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <ActionList actions={assessment.actions} />
                </CardContent>
              </Card>
            </div>
          )}
        </TabsContent>

        {/* ---------------------------- Baseline --------------------------- */}
        <TabsContent value="baseline" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            {assessment && baseline ? (
              <BaselineCard evaluation={assessment.baseline} baselineRecord={baseline} />
            ) : (
              <EmptyState icon={Heart} title="尚無基準資料" description="需要足夠的休息時段量測才能學習個人基準。" />
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-base">基準學習</CardTitle>
                <CardDescription>
                  基準只從休息時段（夜間）的量測學習，以避免活動造成的心率上升拉寬正常範圍。
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {baseline && (
                  <dl className="grid gap-x-4 gap-y-3 sm:grid-cols-2">
                    <Row
                      label="心率範圍"
                      value={`${baseline.heartRate.min}–${baseline.heartRate.max} BPM（平均 ${baseline.heartRate.mean}）`}
                    />
                    <Row
                      label="體表溫度"
                      value={`${baseline.skinTemp.min}–${baseline.skinTemp.max}°C`}
                    />
                    <Row
                      label="活動量"
                      value={`${baseline.activityStepsPerHour.min}–${baseline.activityStepsPerHour.max} 步/小時`}
                    />
                    <Row label="學習樣本數" value={`${baseline.sampleCount} 筆`} />
                    <Row label="信心度" value={`${Math.round(baseline.confidence * 100)}%`} />
                    <Row label="最後學習時間" value={formatDateTime(baseline.learnedAt)} />
                  </dl>
                )}

                {!user.permissions.physiologicalDataStorage && (
                  <p className="flex gap-2 rounded-lg bg-risk-medium-bg p-3 text-xs text-risk-medium">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    此長者尚未同意儲存生理資料，因此無法重新學習基準。
                  </p>
                )}

                {can('user:write') && (
                  <Button variant="outline" onClick={relearn} loading={busy}>
                    <RefreshCw />
                    依最新資料重新學習基準
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>

          <ChartCard title="心率與個人基準範圍" description="綠色區帶為此長者平常的休息心率範圍。">
            <HeartRateChart history={history} />
          </ChartCard>
        </TabsContent>

        {/* -------------------------- Environment -------------------------- */}
        <TabsContent value="environment" className="space-y-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <ChartCard title="溫度與熱指數" description="室內、室外與熱指數的變化。">
              <EnvironmentChart history={history} />
            </ChartCard>
            <ChartCard title="室內濕度" description="濕度越高，排汗散熱效率越低。">
              <HumidityChart history={history} />
            </ChartCard>
          </div>

          <ChartCard title="風險時間軸" description="綜合風險分數隨時間的變化。" height={280}>
            <RiskTimeline history={history} height={280} />
          </ChartCard>

          <ChartCard
            title="降溫成效"
            description="淺綠區段為降溫設備運轉中的時段，可看出室溫是否確實下降。"
          >
            <CoolingEffectivenessChart history={history} />
          </ChartCard>

          {smartHome && <SmartHomeCard smartHome={smartHome} readOnly />}
        </TabsContent>

        {/* ---------------------------- Events ----------------------------- */}
        <TabsContent value="events">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">風險事件紀錄</CardTitle>
              <CardDescription>
                每一次風險等級升高或下降的完整紀錄，共 {riskEvents.length} 筆。
              </CardDescription>
            </CardHeader>
            <CardContent>
              {riskEvents.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  尚無風險等級變化紀錄。
                </p>
              ) : (
                <ol className="relative space-y-5 border-l border-border pl-6">
                  {riskEvents.map((event) => {
                    const escalation = event.reason === 'ESCALATION';
                    return (
                      <li key={event.id} className="relative">
                        <span
                          className={cn(
                            'absolute -left-[31px] flex size-5 items-center justify-center rounded-full border-2 border-card',
                            escalation ? 'bg-risk-high' : 'bg-risk-low',
                          )}
                          aria-hidden
                        >
                          {escalation ? (
                            <ArrowUp className="size-3 text-white" />
                          ) : (
                            <ArrowDown className="size-3 text-white" />
                          )}
                        </span>

                        <div className="flex flex-wrap items-center gap-2">
                          {event.previousLevel && (
                            <>
                              <RiskBadge level={event.previousLevel} size="sm" />
                              <ArrowRight className="size-3 text-muted-foreground" />
                            </>
                          )}
                          <RiskBadge level={event.level} size="sm" />
                          <span className="ml-auto text-xs text-muted-foreground">
                            {formatDateTime(event.recordedAt)}
                          </span>
                        </div>

                        <p className="mt-1.5 text-sm">{event.explanation.headline}</p>

                        <p className="tabular mt-1 text-xs text-muted-foreground">
                          分數 {event.score} · 熱指數 {formatTemp(event.heatIndex)} · 室內{' '}
                          {formatTemp(event.readings.indoorTempC)} · 心率{' '}
                          {Math.round(event.readings.heartRateBpm)} BPM
                        </p>

                        {event.actionsTaken.length > 0 && (
                          <div className="mt-1.5 flex flex-wrap gap-1">
                            {event.actionsTaken.map((action) => (
                              <Badge key={action} variant="secondary" className="text-[10px]">
                                {action}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ---------------------------- Devices ---------------------------- */}
        <TabsContent value="devices" className="space-y-4">
          <Card className="border-dashed shadow-none">
            <CardContent className="flex items-start gap-3 p-4">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <p className="text-xs leading-relaxed text-muted-foreground">
                停用感測器會使其提供的數值停止更新（系統會沿用最後讀值並標示為過時）；停用冷氣會讓自動降溫顯示為「未執行」。這些動作會立即影響此長者的風險判讀。
              </p>
            </CardContent>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2">
            {devices.map((device) => (
              <DeviceCard
                key={device.id}
                device={device}
                busy={busy}
                onAction={can('device:write') ? (action) => void deviceAction(device.id, action) : undefined}
              />
            ))}
          </div>
        </TabsContent>

        {/* --------------------------- Caregivers -------------------------- */}
        <TabsContent value="caregivers">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">指派的照護者</CardTitle>
              <CardDescription>
                {caregivers.length === 0
                  ? '此長者目前沒有指派的照護者，因此通知動作會顯示為未執行。'
                  : `共 ${caregivers.length} 位。通知會依各自的偏好與勿擾時段發送。`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {caregivers.length === 0 ? (
                <EmptyState
                  icon={Users}
                  title="尚未指派照護者"
                  description="請於照護者管理頁面指派負責的家屬或照護人員。"
                  action={
                    <Button asChild variant="outline">
                      <Link to="/admin/caregivers">前往照護者管理</Link>
                    </Button>
                  }
                />
              ) : (
                <ul className="space-y-3">
                  {caregivers.map((caregiver) => (
                    <li
                      key={caregiver.id}
                      className="flex flex-wrap items-start gap-3 rounded-lg border border-border p-4"
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-muted font-semibold text-primary">
                        {caregiver.name.slice(0, 1)}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="font-medium">{caregiver.name}</p>
                          <Badge variant="secondary" className="text-[10px]">
                            {RELATIONSHIP_ZH[caregiver.relationship] ?? caregiver.relationship}
                          </Badge>
                          {caregiver.status === 'INACTIVE' && (
                            <Badge variant="muted" className="text-[10px]">
                              已停用
                            </Badge>
                          )}
                          {caregiver.emergencyPermission && (
                            <Badge variant="warning" className="text-[10px]">
                              可緊急處置
                            </Badge>
                          )}
                        </div>

                        <p className="mt-1 flex flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
                          <span className="flex items-center gap-1">
                            <Phone className="size-3" />
                            {caregiver.phone}
                          </span>
                          <span>{caregiver.email}</span>
                        </p>

                        <p className="mt-1.5 text-xs text-muted-foreground">
                          最低通知等級：{caregiver.notificationPreferences.minLevel} · 管道：
                          {caregiver.notificationPreferences.channels.join('、')}
                          {caregiver.notificationPreferences.quietHours.enabled &&
                            ` · 勿擾 ${caregiver.notificationPreferences.quietHours.from}–${caregiver.notificationPreferences.quietHours.to}`}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* -------------------------- Permissions -------------------------- */}
        <TabsContent value="permissions" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">授權設定</CardTitle>
              <CardDescription>
                這些是長者本人的同意項目。關閉任何一項都會實際改變系統對這位長者的行為。
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {CONSENT_LABELS.map((consent) => (
                <div
                  key={consent.key}
                  className="flex items-start justify-between gap-4 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0">
                    <Label htmlFor={`perm-${consent.key}`}>{consent.label}</Label>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      {consent.effect}
                    </p>
                  </div>
                  <Switch
                    id={`perm-${consent.key}`}
                    checked={user.permissions[consent.key]}
                    disabled={!can('user:write') || busy}
                    onCheckedChange={(value) => void togglePermission(consent.key, value)}
                  />
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Bell className="size-4" />
                近期警示
              </CardTitle>
              <CardDescription>共 {alerts.length} 筆</CardDescription>
            </CardHeader>
            <CardContent>
              {alerts.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">
                  此長者目前沒有警示紀錄。
                </p>
              ) : (
                <ul className="space-y-2">
                  {alerts.map((alert) => (
                    <li
                      key={alert.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border border-border p-3"
                    >
                      <RiskBadge level={alert.level} size="sm" />
                      <Badge
                        variant={
                          alert.status === 'RESOLVED'
                            ? 'success'
                            : alert.status === 'NEW'
                              ? 'danger'
                              : 'warning'
                        }
                        className="text-[10px]"
                      >
                        {ALERT_STATUS_ZH[alert.status]}
                      </Badge>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                        {alert.triggerZh}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {timeAgo(alert.createdAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* ----------------------------- Edit ------------------------------- */}
      <Dialog open={editing} onOpenChange={(open) => !open && setEditing(false)}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>編輯長者資料</DialogTitle>
            <DialogDescription>
              變更會立即生效，並記錄於稽核軌跡。
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="姓名">
              <Input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
            <Field label="電話">
              <Input
                value={draft.phone}
                onChange={(e) => setDraft({ ...draft, phone: e.target.value })}
              />
            </Field>
            <Field label="行政區">
              <Input
                value={draft.district}
                onChange={(e) => setDraft({ ...draft, district: e.target.value })}
              />
            </Field>
            <Field label="地址">
              <Input
                value={draft.address}
                onChange={(e) => setDraft({ ...draft, address: e.target.value })}
              />
            </Field>
          </div>

          <Separator />

          <p className="text-xs font-medium text-muted-foreground">緊急聯絡人</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="姓名">
              <Input
                value={draft.emergencyName}
                onChange={(e) => setDraft({ ...draft, emergencyName: e.target.value })}
              />
            </Field>
            <Field label="關係">
              <Input
                value={draft.emergencyRelationship}
                onChange={(e) =>
                  setDraft({ ...draft, emergencyRelationship: e.target.value })
                }
              />
            </Field>
            <Field label="電話">
              <Input
                value={draft.emergencyPhone}
                onChange={(e) => setDraft({ ...draft, emergencyPhone: e.target.value })}
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(false)}>
              取消
            </Button>
            <Button onClick={() => void saveEdits()} loading={busy}>
              儲存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------------------- Archive ----------------------------- */}
      <Dialog open={confirmArchive} onOpenChange={(open) => !open && setConfirmArchive(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>封存 {user.name}？</DialogTitle>
            <DialogDescription>這個動作可以復原。</DialogDescription>
          </DialogHeader>

          <ul className="space-y-1.5 text-sm text-muted-foreground">
            <li>· 停止監測：不再計算風險、發送通知或自動控制設備</li>
            <li>· 自名冊、城市統計與照護者清單中移除</li>
            <li>· 釋出其所有裝置（金鑰一併撤銷）</li>
            <li>· 歷史紀錄、警示與稽核軌跡<strong className="font-semibold text-foreground">完整保留</strong></li>
          </ul>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmArchive(false)}>
              取消
            </Button>
            <Button onClick={() => void archive()} loading={busy}>
              封存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ----------------------------- Erase ------------------------------ */}
      <Dialog
        open={confirmErase}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmErase(false);
            setEraseTyped('');
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-risk-high">永久刪除 {user.name}？</DialogTitle>
            <DialogDescription>
              這個動作<strong className="font-semibold">無法復原</strong>。
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-risk-high-border bg-risk-high-bg/40 p-3">
              <p className="text-sm text-risk-high">
                將一併刪除此長者的所有讀值、警示、通知與裝置紀錄。
                僅有稽核軌跡會保留「誰在何時刪除了這筆資料」。
              </p>
            </div>

            <p className="text-xs text-muted-foreground">
              若只是要停止監測，請改用<strong className="font-semibold text-foreground">封存</strong>
              ——封存可以復原，而且保留完整病史。
            </p>

            <Field label={`請輸入「${user.name}」以確認`}>
              <Input
                value={eraseTyped}
                onChange={(e) => setEraseTyped(e.target.value)}
                placeholder={user.name}
                autoComplete="off"
              />
            </Field>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmErase(false)}>
              取消
            </Button>
            <Button
              className="bg-risk-high text-white hover:bg-risk-high/90"
              disabled={eraseTyped !== user.name}
              onClick={() => void erase()}
              loading={busy}
            >
              永久刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** A labelled form field, used by the edit and erase dialogs. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">{label}</Label>
      {children}
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={cn('mt-0.5 text-sm', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: 'high' }) {
  return (
    <div className="rounded-lg bg-muted p-2.5">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className={cn('tabular mt-0.5 font-semibold', tone === 'high' && 'text-risk-high')}>
        {value}
      </p>
    </div>
  );
}

function genderZh(gender: 'M' | 'F' | 'OTHER'): string {
  return gender === 'F' ? '女性' : gender === 'M' ? '男性' : '其他';
}
