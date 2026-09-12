/**
 * 指引 - the resident's "what should I do now" surface.
 *
 * The dashboard answers 目前安全嗎 and 為什麼. This page answers only the third
 * question, 我該做什麼, and answers it in the order the policy engine ranked:
 * the actions it produced, then somewhere cooler to go, then background
 * reading, then who to call. Nothing here re-derives a threshold or a level -
 * every instruction on the page is the server's, rendered verbatim.
 */

import * as React from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  BookOpen,
  ChevronDown,
  Clock,
  Compass,
  Info,
  ListChecks,
  MapPin,
  PhoneCall,
  ShieldAlert,
  Snowflake,
  Users,
} from 'lucide-react';

import type {
  Caregiver,
  ContentArticle,
  CoolingSpaceRecommendation,
  ElderlyUser,
} from '@shared/types/domain';
import { ApiError, api } from '@/lib/api';
import { selectAssessment, useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { ActionList, CoolingSpaceCard, PageHeader } from '@/components/domain/Cards';
import { EmptyState, RiskIcon, RiskSummaryStrip } from '@/components/domain/RiskIndicators';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
  Skeleton,
} from '@/components/ui';
import {
  CONTENT_CATEGORY_ZH,
  RELATIONSHIP_ZH,
  RISK_STYLES,
  cn,
  formatDateTime,
  formatTime,
} from '@/lib/utils';

// ---------------------------------------------------------------------------
// Local loading state shapes
// ---------------------------------------------------------------------------

interface CoolingState {
  loading: boolean;
  error: string | null;
  recommendations: CoolingSpaceRecommendation[];
  /** Location sharing is switched off - a different situation from "none nearby". */
  blocked: boolean;
  reasonZh: string | null;
}

interface ContentState {
  loading: boolean;
  error: string | null;
  articles: ContentArticle[];
}

interface ContactState {
  loading: boolean;
  error: string | null;
  user: ElderlyUser | null;
  caregivers: Caregiver[];
  /**
   * True when this account may see its own emergency contact but not the
   * caregiver directory - a resident account holds no caregiver read
   * permission, and inventing the numbers would be worse than saying so.
   */
  restricted: boolean;
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export default function GuidePage() {
  const focusUserId = useSession((s) => s.focusUserId());
  const elderMode = useSession((s) => s.elderMode);
  const sessionElderlyUser = useSession((s) => s.elderlyUser);

  const assessment = useLiveStore(selectAssessment(focusUserId));
  const connection = useLiveStore((s) => s.connection);

  const level = assessment?.level ?? null;

  const [cooling, setCooling] = React.useState<CoolingState>({
    loading: true,
    error: null,
    recommendations: [],
    blocked: false,
    reasonZh: null,
  });
  const [content, setContent] = React.useState<ContentState>({
    loading: true,
    error: null,
    articles: [],
  });
  const [contacts, setContacts] = React.useState<ContactState>({
    loading: true,
    error: null,
    user: null,
    caregivers: [],
    restricted: false,
  });

  // --- cooling spaces -------------------------------------------------------
  // Refetched when the level changes: the ranking weights air conditioning
  // more heavily once the resident is at or above MEDIUM risk.
  const loadCooling = React.useCallback(async () => {
    if (!focusUserId) return;
    setCooling((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.recommendCoolingSpaces(focusUserId);
      setCooling({
        loading: false,
        error: null,
        recommendations: result.recommendations,
        blocked: result.blocked,
        reasonZh: result.reasonZh ?? null,
      });
    } catch (error) {
      setCooling({
        loading: false,
        error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
        recommendations: [],
        blocked: false,
        reasonZh: null,
      });
    }
  }, [focusUserId]);

  React.useEffect(() => {
    void loadCooling();
    // `level` participates so the ranking follows the live risk level.
  }, [loadCooling, level]);

  // --- educational content --------------------------------------------------
  const loadContent = React.useCallback(async () => {
    if (!level) return;
    setContent((s) => ({ ...s, loading: true, error: null }));
    try {
      const result = await api.listContent({ level });
      setContent({
        loading: false,
        error: null,
        // Staff accounts receive drafts too; a resident reads published only.
        articles: result.articles.filter((article) => article.published),
      });
    } catch (error) {
      setContent({
        loading: false,
        error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
        articles: [],
      });
    }
  }, [level]);

  React.useEffect(() => {
    void loadContent();
  }, [loadContent]);

  // --- emergency contacts ---------------------------------------------------
  React.useEffect(() => {
    if (!focusUserId) return;
    let cancelled = false;

    setContacts((s) => ({ ...s, loading: true, error: null }));

    api
      .getUser(focusUserId)
      .then((detail) => {
        if (cancelled) return;
        setContacts({
          loading: false,
          error: null,
          user: detail.user,
          caregivers: detail.caregivers.filter((c) => c.status === 'ACTIVE'),
          restricted: false,
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;

        // A resident account cannot read the caregiver directory. It can still
        // see its own emergency contact, which the session already holds.
        const forbidden = error instanceof ApiError && (error.status === 403 || error.status === 401);
        if (forbidden && sessionElderlyUser && sessionElderlyUser.id === focusUserId) {
          setContacts({
            loading: false,
            error: null,
            user: sessionElderlyUser,
            caregivers: [],
            restricted: true,
          });
          return;
        }

        setContacts({
          loading: false,
          error: error instanceof ApiError ? error.displayMessage : '請稍後再試。',
          user: null,
          caregivers: [],
          restricted: false,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [focusUserId, sessionElderlyUser]);

  // --- guards ---------------------------------------------------------------

  if (!focusUserId) {
    return (
      <>
        <PageHeader title="指引" description="依照目前的風險，告訴您現在該做什麼。" />
        <EmptyState
          icon={Compass}
          title="尚未選擇要檢視的長者"
          description="此帳號沒有綁定長者資料，因此無法產生個人化的行動指引。"
          action={
            <Button asChild variant="outline">
              <Link to="/app">回到總覽</Link>
            </Button>
          }
        />
      </>
    );
  }

  if (!assessment) {
    return (
      <>
        <PageHeader title="指引" description="依照目前的風險，告訴您現在該做什麼。" />
        {connection === 'error' ? (
          <EmptyState
            icon={AlertTriangle}
            title="目前無法取得即時風險資料"
            description="與伺服器的即時連線中斷，重新連線後會自動更新這個頁面。"
            action={
              <Button onClick={() => window.location.reload()}>重新載入</Button>
            }
          />
        ) : (
          <div className="space-y-4">
            <Skeleton className="h-28 w-full rounded-xl" />
            <Skeleton className="h-56 w-full rounded-xl" />
            <Skeleton className="h-40 w-full rounded-xl" />
          </div>
        )}
      </>
    );
  }

  const style = RISK_STYLES[assessment.level];
  const isHigh = assessment.level === 'HIGH';
  const buttonSize = elderMode ? 'elder' : 'lg';
  const spaces = elderMode ? cooling.recommendations.slice(0, 3) : cooling.recommendations;

  const emergencyBlock = (
    <EmergencySection
      state={contacts}
      prominent={isHigh}
      elderMode={elderMode}
      buttonSize={buttonSize}
    />
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="指引"
        description="依照您目前的熱風險，這裡列出現在可以做的事，以及可以去哪裡避熱。"
        actions={
          <Button asChild variant="outline">
            <Link to="/app">
              <ShieldAlert />
              查看完整分析
            </Link>
          </Button>
        }
      />

      {/* ----------------------- Current risk, compact ---------------------- */}
      <Card className={cn('border', style.border, style.bg)}>
        <CardContent className="space-y-3 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <span
              className={cn(
                'flex size-12 shrink-0 items-center justify-center rounded-xl',
                style.solid,
                style.solidText,
              )}
            >
              <RiskIcon level={assessment.level} className="size-6" />
            </span>

            <div className="min-w-0 flex-1">
              <p className={cn('font-bold leading-tight', style.text, elderMode ? 'text-2xl' : 'text-xl')}>
                {style.plainZh}
              </p>
              <p
                className={cn(
                  'mt-0.5 leading-snug text-muted-foreground',
                  elderMode ? 'text-lg' : 'text-sm',
                )}
              >
                {assessment.explanation.headline}
              </p>
            </div>

            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Clock className="size-3.5" />
              {formatTime(assessment.timestamp)} 更新
            </span>
          </div>

          <div className="elder-hide">
            <RiskSummaryStrip assessment={assessment} />
          </div>
        </CardContent>
      </Card>

      {/* HIGH risk puts the phone numbers above everything except the header. */}
      {isHigh && emergencyBlock}

      {/* --------------------------- Action list ---------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
              <ListChecks className="size-4 text-primary" />
            </span>
            <div>
              <CardTitle className={elderMode ? 'text-xl' : 'text-base'}>現在建議您做的事</CardTitle>
              <CardDescription className="text-xs">
                由平台的行動政策依目前風險產生，標示「系統已自動執行」的項目不需要您動手。
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ActionList actions={assessment.actions} large />
        </CardContent>
      </Card>

      {/* ------------------------- Cooling spaces --------------------------- */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
                <Snowflake className="size-4 text-primary" />
              </span>
              <div>
                <CardTitle className={elderMode ? 'text-xl' : 'text-base'}>附近的涼適空間</CardTitle>
                <CardDescription className="text-xs">
                  依距離、是否有冷氣、無障礙進出與現在是否開放排序。
                </CardDescription>
              </div>
            </div>

            <Button asChild variant="outline" size="sm">
              <Link to="/app/heat-map">
                <MapPin />
                在地圖上查看
              </Link>
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          {cooling.loading ? (
            <>
              <Skeleton className="h-24 w-full rounded-xl" />
              <Skeleton className="h-24 w-full rounded-xl" />
            </>
          ) : cooling.error ? (
            <EmptyState
              icon={AlertTriangle}
              title="無法載入涼適空間"
              description={cooling.error}
              action={<Button onClick={() => void loadCooling()}>重試</Button>}
            />
          ) : cooling.blocked ? (
            <EmptyState
              icon={MapPin}
              title="位置分享已關閉"
              description={
                cooling.reasonZh ??
                '位置分享已關閉，因此無法建議附近的涼適空間。您仍然可以在地圖上自行查看全市的涼適空間。'
              }
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button asChild>
                    <Link to="/app/privacy">前往隱私設定</Link>
                  </Button>
                  <Button asChild variant="outline">
                    <Link to="/app/heat-map">改看全市地圖</Link>
                  </Button>
                </div>
              }
            />
          ) : spaces.length === 0 ? (
            <EmptyState
              icon={Snowflake}
              title="附近沒有可建議的涼適空間"
              description={cooling.reasonZh ?? '搜尋範圍內目前沒有啟用中的涼適空間。'}
              action={
                <Button asChild variant="outline">
                  <Link to="/app/heat-map">查看全市地圖</Link>
                </Button>
              }
            />
          ) : (
            <ul className="space-y-3">
              {spaces.map((space) => (
                <li key={space.id} className="space-y-1">
                  <CoolingSpaceCard space={space} large={elderMode} />
                  <p className="px-1 text-xs text-muted-foreground">
                    推薦原因：{space.reasonZh}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --------------------- Education (hidden in elder mode) ------------- */}
      {!elderMode && (
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary-muted">
                <BookOpen className="size-4 text-primary" />
              </span>
              <div>
                <CardTitle className="text-base">適合現在閱讀的防暑資訊</CardTitle>
                <CardDescription className="text-xs">
                  由平台編輯維護，只顯示對應「{style.labelZh}」的內容。
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          <CardContent className="space-y-2.5">
            {content.loading ? (
              <>
                <Skeleton className="h-20 w-full rounded-xl" />
                <Skeleton className="h-20 w-full rounded-xl" />
              </>
            ) : content.error ? (
              <EmptyState
                icon={AlertTriangle}
                title="無法載入防暑資訊"
                description={content.error}
                action={<Button onClick={() => void loadContent()}>重試</Button>}
              />
            ) : content.articles.length === 0 ? (
              <EmptyState
                icon={BookOpen}
                title="目前沒有對應的文章"
                description={`平台尚未針對「${style.labelZh}」發布衛教內容。`}
              />
            ) : (
              content.articles.map((article) => (
                <ArticleDisclosure key={article.id} article={article} />
              ))
            )}
          </CardContent>
        </Card>
      )}

      {/* Below HIGH the emergency numbers sit at the foot of the page. */}
      {!isHigh && emergencyBlock}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Emergency assistance
// ---------------------------------------------------------------------------

function EmergencySection({
  state,
  prominent,
  elderMode,
  buttonSize,
}: {
  state: ContactState;
  prominent: boolean;
  elderMode: boolean;
  buttonSize: 'lg' | 'elder';
}) {
  const { user, caregivers, restricted, loading, error } = state;

  return (
    <Card className={cn(prominent && 'border-2 border-risk-high-border bg-risk-high-bg/40')}>
      <CardHeader>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'flex size-8 items-center justify-center rounded-lg',
              prominent ? 'bg-risk-high text-white' : 'bg-muted text-muted-foreground',
            )}
          >
            <PhoneCall className="size-4" />
          </span>
          <div>
            <CardTitle className={cn(elderMode ? 'text-xl' : 'text-base', prominent && 'text-risk-high')}>
              需要協助時，請直接撥打電話
            </CardTitle>
            <CardDescription className="text-xs">
              {prominent
                ? '目前為高風險。若感到不適、頭暈或無力，請立即聯絡以下任一位。'
                : '目前不需要緊急協助，號碼保留在這裡以備不時之需。'}
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {loading ? (
          <>
            <Skeleton className="h-12 w-full rounded-xl" />
            <Skeleton className="h-12 w-full rounded-xl" />
          </>
        ) : error ? (
          <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">
            無法載入聯絡人資料（{error}）。緊急狀況請直接撥打 119。
          </p>
        ) : (
          <>
            {/* 119 is always available and never depends on a fetch. */}
            <Button
              asChild
              size={buttonSize}
              variant={prominent ? 'danger' : 'outline'}
              className="w-full justify-start"
            >
              <a href="tel:119">
                <PhoneCall />
                <span className="flex flex-col items-start leading-tight">
                  <span>撥打 119 消防救護</span>
                  <span className="text-xs font-normal opacity-80">意識不清或無法自行降溫時</span>
                </span>
              </a>
            </Button>

            {user && (
              <Button asChild size={buttonSize} variant="outline" className="w-full justify-start">
                <a href={`tel:${user.emergencyContact.phone}`}>
                  <PhoneCall />
                  <span className="flex flex-col items-start leading-tight">
                    <span>
                      緊急聯絡人 · {user.emergencyContact.name}（{user.emergencyContact.relationship}）
                    </span>
                    <span className="tabular text-xs font-normal opacity-80">
                      {user.emergencyContact.phone}
                    </span>
                  </span>
                </a>
              </Button>
            )}

            {caregivers.length > 0 && (
              <>
                <Separator />
                <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Users className="size-3.5" />
                  指派的照護者
                </p>
                <ul className="space-y-2">
                  {caregivers.map((caregiver) => (
                    <li key={caregiver.id}>
                      <Button
                        asChild
                        size={buttonSize}
                        variant="outline"
                        className="w-full justify-start"
                      >
                        <a href={`tel:${caregiver.phone}`}>
                          <PhoneCall />
                          <span className="flex flex-col items-start leading-tight">
                            <span className="flex flex-wrap items-center gap-2">
                              {caregiver.name}
                              <Badge variant="muted" className="text-[10px]">
                                {RELATIONSHIP_ZH[caregiver.relationship] ?? caregiver.relationship}
                              </Badge>
                              {caregiver.emergencyPermission && (
                                <Badge variant="secondary" className="text-[10px]">
                                  可代為求助
                                </Badge>
                              )}
                            </span>
                            <span className="tabular text-xs font-normal opacity-80">
                              {caregiver.phone}
                            </span>
                          </span>
                        </a>
                      </Button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            {restricted && (
              <p className="flex gap-2 rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                <Info className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  為保護個資，您的帳號只會顯示自己的緊急聯絡人。風險升高時，平台會依通知政策
                  自動聯絡已指派的照護者。
                </span>
              </p>
            )}

            {user && !user.permissions.caregiverNotifications && (
              <p className="flex gap-2 rounded-lg border border-risk-medium-border bg-risk-medium-bg p-3 text-xs leading-relaxed text-risk-medium">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  您目前已關閉「通知照護者」，因此系統不會主動聯絡家人。
                  <Link to="/app/privacy" className="ml-1 font-semibold underline underline-offset-2">
                    前往隱私設定調整
                  </Link>
                </span>
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Article disclosure
// ---------------------------------------------------------------------------

function ArticleDisclosure({ article }: { article: ContentArticle }) {
  const [open, setOpen] = React.useState(false);
  const panelId = React.useId();

  return (
    <Card className="overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={panelId}
        className={cn(
          'flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-accent/50',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        )}
      >
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <BookOpen className="size-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{article.titleZh}</span>
            <Badge variant="muted" className="text-[10px]">
              {CONTENT_CATEGORY_ZH[article.category] ?? article.category}
            </Badge>
          </span>
          <span className="mt-1 block text-sm leading-relaxed text-muted-foreground">
            {article.summaryZh}
          </span>
        </span>

        <ChevronDown
          className={cn(
            'mt-1 size-5 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>

      <div id={panelId} hidden={!open} className="border-t border-border px-4 py-4">
        <p className="whitespace-pre-line text-sm leading-relaxed">{article.bodyZh}</p>
        <p className="mt-3 text-xs text-muted-foreground">
          最後更新：{formatDateTime(article.updatedAt)}
        </p>
      </div>
    </Card>
  );
}
