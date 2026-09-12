/**
 * 衛教內容 - educational material shown to residents.
 *
 * Validation on the server rejects medical claims: diagnosis, treatment
 * promises and guarantees. That rule is stated in the editor BEFORE an admin
 * can hit it, because a guardrail that only appears as an error message reads
 * as a bug rather than as a deliberate safety constraint.
 */

import * as React from 'react';
import {
  AlertTriangle,
  BookOpen,
  Eye,
  FileText,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import type { ContentArticle, ContentCategory, RiskLevel } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/store/session';
import { cn, CONTENT_CATEGORY_ZH, formatDateTime, RISK_STYLES } from '@/lib/utils';
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
  Field,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState, RiskBadge } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';

const CATEGORIES = Object.keys(CONTENT_CATEGORY_ZH) as ContentCategory[];
const LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH'];

interface Draft {
  id?: string;
  slug: string;
  title: string;
  titleZh: string;
  category: ContentCategory;
  summary: string;
  summaryZh: string;
  body: string;
  bodyZh: string;
  showForLevels: RiskLevel[];
  published: boolean;
}

const EMPTY: Draft = {
  slug: '',
  title: '',
  titleZh: '',
  category: 'HEAT_PREVENTION',
  summary: '',
  summaryZh: '',
  body: '',
  bodyZh: '',
  showForLevels: ['LOW', 'MEDIUM', 'HIGH'],
  published: false,
};

export default function AdminContent() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const editable = can('content:write');

  const [articles, setArticles] = React.useState<ContentArticle[]>([]);
  const [summary, setSummary] = React.useState({ published: 0, draft: 0 });
  const [policy, setPolicy] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [categoryFilter, setCategoryFilter] = React.useState('ALL');
  const [stateFilter, setStateFilter] = React.useState('ALL');

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [deleteTarget, setDeleteTarget] = React.useState<ContentArticle | null>(null);
  const [previewArticle, setPreviewArticle] = React.useState<ContentArticle | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.listContent();
      setArticles(result.articles);
      setSummary(result.summary);
      setPolicy(result.contentPolicyZh);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入衛教內容。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(
    () =>
      articles.filter((article) => {
        if (categoryFilter !== 'ALL' && article.category !== categoryFilter) return false;
        if (stateFilter === 'PUBLISHED' && !article.published) return false;
        if (stateFilter === 'DRAFT' && article.published) return false;
        return true;
      }),
    [articles, categoryFilter, stateFilter],
  );

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setFieldErrors({});

    const payload = {
      slug: draft.slug,
      title: draft.title,
      titleZh: draft.titleZh,
      category: draft.category,
      summary: draft.summary,
      summaryZh: draft.summaryZh,
      body: draft.body,
      bodyZh: draft.bodyZh,
      showForLevels: draft.showForLevels,
      published: draft.published,
    };

    try {
      if (draft.id) {
        await api.updateArticle(draft.id, payload);
        toast.success('內容已更新');
      } else {
        await api.createArticle(payload);
        toast.success('內容已建立', draft.published ? '已發布給長者。' : '已儲存為草稿。');
      }
      setDraft(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error(
          '內容未儲存',
          Object.keys(err.fieldErrors).length > 0
            ? '部分欄位不符合內容規範，請見欄位下方的說明。'
            : err.displayMessage,
        );
      } else {
        toast.error('內容未儲存', '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  const togglePublished = async (article: ContentArticle) => {
    setBusy(true);
    try {
      await api.updateArticle(article.id, { published: !article.published });
      toast.success(article.published ? '已取消發布' : '已發布', {
        true: '長者端將不再看到這篇內容。',
        false: '長者在對應的風險等級時會看到這篇內容。',
      }[String(article.published) as 'true' | 'false']);
      await load();
    } catch (err) {
      toast.error('操作失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deleteArticle(deleteTarget.id);
      toast.success('內容已刪除');
      setDeleteTarget(null);
      await load();
    } catch (err) {
      toast.error('無法刪除', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  // ---------------------------------------------------------------------

  const columns: Column<ContentArticle>[] = [
    {
      key: 'title',
      header: '標題',
      primary: true,
      sortValue: (row) => row.titleZh,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.titleZh}</p>
          <p className="truncate font-mono text-[11px] text-muted-foreground">{row.slug}</p>
        </div>
      ),
    },
    {
      key: 'category',
      header: '分類',
      sortValue: (row) => row.category,
      cell: (row) => (
        <Badge variant="secondary" className="text-[10px]">
          {CONTENT_CATEGORY_ZH[row.category] ?? row.category}
        </Badge>
      ),
    },
    {
      key: 'levels',
      header: '顯示時機',
      hideOnMobile: true,
      cell: (row) => (
        <div className="flex flex-wrap gap-1">
          {row.showForLevels.map((level) => (
            <RiskBadge key={level} level={level} size="sm" />
          ))}
        </div>
      ),
    },
    {
      key: 'published',
      header: '狀態',
      sortValue: (row) => (row.published ? 0 : 1),
      cell: (row) =>
        row.published ? (
          <Badge variant="success" className="text-[10px]">
            已發布
          </Badge>
        ) : (
          <Badge variant="muted" className="text-[10px]">
            草稿
          </Badge>
        ),
    },
    {
      key: 'updated',
      header: '最後更新',
      hideOnMobile: true,
      sortValue: (row) => new Date(row.updatedAt).getTime(),
      cell: (row) => (
        <div className="text-xs text-muted-foreground">
          <p>{formatDateTime(row.updatedAt)}</p>
          <p>{row.updatedBy}</p>
        </div>
      ),
    },
    {
      key: 'actions',
      header: '操作',
      align: 'right',
      cell: (row) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          <Button size="sm" variant="ghost" onClick={() => setPreviewArticle(row)}>
            <Eye />
            預覽
          </Button>
          {editable && (
            <>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setDraft({
                    id: row.id,
                    slug: row.slug,
                    title: row.title,
                    titleZh: row.titleZh,
                    category: row.category,
                    summary: row.summary,
                    summaryZh: row.summaryZh,
                    body: row.body,
                    bodyZh: row.bodyZh,
                    showForLevels: [...row.showForLevels],
                    published: row.published,
                  })
                }
              >
                編輯
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void togglePublished(row)}
                disabled={busy}
              >
                {row.published ? '取消發布' : '發布'}
              </Button>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => setDeleteTarget(row)}
                aria-label={`刪除 ${row.titleZh}`}
              >
                <Trash2 />
              </Button>
            </>
          )}
        </div>
      ),
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="衛教內容" description="載入中…" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="衛教內容" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入衛教內容"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="衛教內容"
        description="提供給長者的防暑與安全資訊。內容會依風險等級顯示在「指引」頁面。"
        actions={
          editable && (
            <Button onClick={() => { setDraft({ ...EMPTY }); setFieldErrors({}); }}>
              <Plus />
              新增內容
            </Button>
          )
        }
      />

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="已發布" value={summary.published} icon={BookOpen} tone="low" />
        <StatCard label="草稿" value={summary.draft} icon={FileText} tone="neutral" />
        <StatCard label="總計" value={articles.length} icon={FileText} tone="primary" />
      </div>

      {/* The guardrail, stated before it is hit. */}
      <Card className="border-primary/25 bg-primary-muted/40">
        <CardContent className="flex items-start gap-3 p-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
          <div className="text-sm">
            <p className="font-medium">內容規範</p>
            <p className="mt-1 leading-relaxed text-muted-foreground">
              {policy ||
                '文章必須採用安全導向的用語。診斷、療效或保證性字句會被驗證擋下。'}
              {' '}
              這是刻意設計的安全限制：此平台提供的是防暑安全建議，不是醫療診斷或治療承諾。
            </p>
          </div>
        </CardContent>
      </Card>

      <DataTable
        rows={filtered}
        columns={columns}
        getRowKey={(row) => row.id}
        searchPlaceholder="搜尋標題或內容…"
        searchFields={(row) => `${row.titleZh} ${row.title} ${row.slug} ${row.summaryZh}`}
        initialSort={{ key: 'updated', direction: 'desc' }}
        filters={[
          {
            key: 'category',
            label: '分類',
            value: categoryFilter,
            onChange: setCategoryFilter,
            options: [
              { value: 'ALL', label: '全部分類' },
              ...CATEGORIES.map((c) => ({ value: c, label: CONTENT_CATEGORY_ZH[c] })),
            ],
          },
          {
            key: 'state',
            label: '狀態',
            value: stateFilter,
            onChange: setStateFilter,
            options: [
              { value: 'ALL', label: '全部狀態' },
              { value: 'PUBLISHED', label: '已發布' },
              { value: 'DRAFT', label: '草稿' },
            ],
          },
        ]}
        emptyState={
          <EmptyState icon={BookOpen} title="沒有符合條件的內容" description="請調整搜尋或篩選條件。" />
        }
      />

      {/* ---------------------------- Editor ------------------------------- */}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>{draft?.id ? '編輯內容' : '新增內容'}</DialogTitle>
            <DialogDescription>
              請使用安全導向的用語，例如「建議補充水分」而非承諾療效。
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <Tabs defaultValue="edit">
              <TabsList>
                <TabsTrigger value="edit">編輯</TabsTrigger>
                <TabsTrigger value="preview">長者端預覽</TabsTrigger>
              </TabsList>

              <TabsContent value="edit" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field
                    label="網址代稱（slug）"
                    required
                    hint="小寫英文、數字與連字號"
                    error={fieldErrors.slug}
                  >
                    <Input
                      value={draft.slug}
                      onChange={(e) =>
                        setDraft({ ...draft, slug: e.target.value.toLowerCase().replace(/\s+/g, '-') })
                      }
                      placeholder="hydration-basics"
                    />
                  </Field>

                  <Field label="分類" required error={fieldErrors.category}>
                    <Select
                      value={draft.category}
                      onValueChange={(v) => setDraft({ ...draft, category: v as ContentCategory })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {CATEGORIES.map((category) => (
                          <SelectItem key={category} value={category}>
                            {CONTENT_CATEGORY_ZH[category]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </Field>
                </div>

                <Field label="標題（中文）" required error={fieldErrors.titleZh}>
                  <Input
                    value={draft.titleZh}
                    onChange={(e) => setDraft({ ...draft, titleZh: e.target.value })}
                    placeholder="高溫時如何補充足夠水分"
                  />
                </Field>

                <Field label="摘要（中文）" required error={fieldErrors.summaryZh}>
                  <Textarea
                    rows={2}
                    value={draft.summaryZh}
                    onChange={(e) => setDraft({ ...draft, summaryZh: e.target.value })}
                    placeholder="一兩句話說明這篇內容的重點。"
                  />
                </Field>

                <Field label="內文（中文）" required error={fieldErrors.bodyZh}>
                  <Textarea
                    rows={7}
                    value={draft.bodyZh}
                    onChange={(e) => setDraft({ ...draft, bodyZh: e.target.value })}
                    placeholder="以平實、尊重的語氣說明，直接稱呼長者為「您」。"
                  />
                </Field>

                <details className="rounded-lg border border-border p-3">
                  <summary className="cursor-pointer text-sm font-medium">英文版本</summary>
                  <div className="mt-3 space-y-4">
                    <Field label="Title" required error={fieldErrors.title}>
                      <Input
                        value={draft.title}
                        onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                      />
                    </Field>
                    <Field label="Summary" required error={fieldErrors.summary}>
                      <Textarea
                        rows={2}
                        value={draft.summary}
                        onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
                      />
                    </Field>
                    <Field label="Body" required error={fieldErrors.body}>
                      <Textarea
                        rows={5}
                        value={draft.body}
                        onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                      />
                    </Field>
                  </div>
                </details>

                <div>
                  <Label className="mb-1.5 block">在哪些風險等級顯示</Label>
                  <div className="flex flex-wrap gap-2">
                    {LEVELS.map((level) => {
                      const selected = draft.showForLevels.includes(level);
                      return (
                        <button
                          key={level}
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              showForLevels: selected
                                ? draft.showForLevels.filter((l) => l !== level)
                                : [...draft.showForLevels, level],
                            })
                          }
                          className={cn(
                            'rounded-lg border px-3 py-1.5 text-xs transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selected
                              ? cn(RISK_STYLES[level].bg, RISK_STYLES[level].text, RISK_STYLES[level].border)
                              : 'border-border hover:bg-accent',
                          )}
                        >
                          {RISK_STYLES[level].labelZh}
                        </button>
                      );
                    })}
                  </div>
                  {fieldErrors.showForLevels && (
                    <p role="alert" className="mt-1 text-xs font-medium text-destructive">
                      {fieldErrors.showForLevels}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
                  <div>
                    <Label htmlFor="content-published">發布給長者</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      未發布的內容只有管理者看得到。
                    </p>
                  </div>
                  <Switch
                    id="content-published"
                    checked={draft.published}
                    onCheckedChange={(v) => setDraft({ ...draft, published: v })}
                  />
                </div>
              </TabsContent>

              <TabsContent value="preview">
                <ArticlePreview
                  titleZh={draft.titleZh}
                  summaryZh={draft.summaryZh}
                  bodyZh={draft.bodyZh}
                  category={draft.category}
                  levels={draft.showForLevels}
                />
              </TabsContent>
            </Tabs>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button onClick={save} loading={busy}>
              {draft?.id ? '儲存變更' : '建立內容'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* --------------------------- Preview dialog ------------------------ */}
      <Dialog open={Boolean(previewArticle)} onOpenChange={(open) => !open && setPreviewArticle(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>長者端預覽</DialogTitle>
            <DialogDescription>這是長者在「指引」頁面看到的樣子。</DialogDescription>
          </DialogHeader>

          {previewArticle && (
            <ArticlePreview
              titleZh={previewArticle.titleZh}
              summaryZh={previewArticle.summaryZh}
              bodyZh={previewArticle.bodyZh}
              category={previewArticle.category}
              levels={previewArticle.showForLevels}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* --------------------------- Delete dialog ------------------------- */}
      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>刪除這篇內容？</DialogTitle>
            <DialogDescription>
              「{deleteTarget?.titleZh}」將被永久移除，長者端也不會再看到。此操作會記錄於操作紀錄。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={remove} loading={busy}>
              確認刪除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ArticlePreview({
  titleZh,
  summaryZh,
  bodyZh,
  category,
  levels,
}: {
  titleZh: string;
  summaryZh: string;
  bodyZh: string;
  category: ContentCategory;
  levels: RiskLevel[];
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[10px]">
            {CONTENT_CATEGORY_ZH[category] ?? category}
          </Badge>
          {levels.map((level) => (
            <RiskBadge key={level} level={level} size="sm" />
          ))}
        </div>
        <CardTitle className="mt-2 text-xl">{titleZh || '（尚未輸入標題）'}</CardTitle>
        <CardDescription className="text-base">{summaryZh}</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="whitespace-pre-wrap text-base leading-relaxed">
          {bodyZh || '（尚未輸入內文）'}
        </p>
      </CardContent>
    </Card>
  );
}
