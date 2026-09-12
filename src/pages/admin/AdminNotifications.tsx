/**
 * 通知中心 - notification templates and the sent-message log.
 *
 * Editing a template genuinely changes the message a caregiver receives, and
 * disabling one stops that notification being sent at all. The live preview
 * renders the draft against real current data so an admin sees the actual
 * sentence before saving it.
 *
 * The test-send deliberately reports suppression as suppression. A send
 * blocked by consent, caregiver preference, quiet hours or the cooldown is
 * correct behaviour, and presenting it as success would teach the admin that
 * their switches do nothing.
 */

import * as React from 'react';
import {
  AlertTriangle,
  Bell,
  BellOff,
  CheckCheck,
  Mail,
  MessageSquare,
  Phone,
  Send,
  Smartphone,
  Variable,
} from 'lucide-react';

import type {
  NotificationChannel,
  NotificationTemplate,
  NotificationTemplateKey,
} from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useSession } from '@/store/session';
import { CHANNEL_ZH, cn, timeAgo } from '@/lib/utils';
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
  Separator,
  Skeleton,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@/components/ui';
import { PageHeader, StatCard } from '@/components/domain/Cards';
import { EmptyState } from '@/components/domain/RiskIndicators';
import { DataTable, type Column } from '@/components/domain/DataTable';

const CHANNEL_ICONS: Record<NotificationChannel, React.ComponentType<{ className?: string }>> = {
  PUSH: Bell,
  SMS: MessageSquare,
  EMAIL: Mail,
  IN_APP: Smartphone,
  VOICE_CALL: Phone,
};

const ALL_CHANNELS: NotificationChannel[] = ['IN_APP', 'PUSH', 'SMS', 'EMAIL', 'VOICE_CALL'];

interface Draft {
  key: NotificationTemplateKey;
  title: string;
  titleZh: string;
  body: string;
  bodyZh: string;
  channels: NotificationChannel[];
  enabled: boolean;
}

export default function AdminNotifications() {
  const toast = useToast();
  const can = useSession((s) => s.can);
  const notifications = useLiveStore((s) => s.notifications);

  const editable = can('notification:write');

  const [templates, setTemplates] = React.useState<NotificationTemplate[]>([]);
  const [variables, setVariables] = React.useState<
    { key: string; description: string; descriptionZh: string }[]
  >([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [preview, setPreview] = React.useState<{ titleZh: string; bodyZh: string } | null>(null);
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});

  const [testTemplate, setTestTemplate] = React.useState<NotificationTemplateKey | null>(null);
  const [testUserId, setTestUserId] = React.useState('user-001');
  const [residents, setResidents] = React.useState<{ id: string; name: string }[]>([]);

  // The last focused textarea, so variable chips insert into the right field.
  const focusedField = React.useRef<'title' | 'titleZh' | 'body' | 'bodyZh'>('bodyZh');

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const result = await api.listTemplates();
      setTemplates(result.templates);
      setVariables(result.variables);
    } catch (err) {
      setError(err instanceof ApiError ? err.displayMessage : '無法載入通知範本。');
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    api
      .listUsers()
      .then((result) => setResidents(result.users.map((u) => ({ id: u.id, name: u.name }))))
      .catch(() => undefined);
  }, []);

  // Live preview against real current data, debounced while typing.
  React.useEffect(() => {
    if (!draft) {
      setPreview(null);
      return;
    }

    let cancelled = false;
    const timer = setTimeout(() => {
      api
        .previewTemplate(draft.key, {
          titleZh: draft.titleZh,
          bodyZh: draft.bodyZh,
          title: draft.title,
          body: draft.body,
          userId: testUserId,
        })
        .then((result) => {
          if (!cancelled) {
            setPreview({ titleZh: result.preview.titleZh, bodyZh: result.preview.bodyZh });
          }
        })
        .catch(() => {
          if (!cancelled) setPreview(null);
        });
    }, 350);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [draft, testUserId]);

  const toggleEnabled = async (template: NotificationTemplate) => {
    setBusy(true);
    try {
      await api.updateTemplate(template.key, { enabled: !template.enabled });
      toast.success(
        template.enabled ? `已停用「${template.nameZh}」` : `已啟用「${template.nameZh}」`,
        template.enabled
          ? '此類型的通知將完全不會發送，直到重新啟用為止。'
          : '此類型的通知已恢復發送。',
      );
      await load();
    } catch (err) {
      toast.error('無法更新範本', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setFieldErrors({});
    try {
      await api.updateTemplate(draft.key, {
        title: draft.title,
        titleZh: draft.titleZh,
        body: draft.body,
        bodyZh: draft.bodyZh,
        channels: draft.channels,
        enabled: draft.enabled,
      });
      toast.success('範本已更新', '之後由系統發出的此類通知都會使用新的文字。');
      setDraft(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError) {
        setFieldErrors(err.fieldErrors);
        toast.error('範本未儲存', err.displayMessage);
      } else {
        toast.error('範本未儲存', '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    if (!testTemplate) return;
    setBusy(true);
    try {
      const result = await api.sendTestNotification(testTemplate, testUserId);
      if (result.sent) {
        toast.success('測試通知已送出', '已依照護者的通知偏好發送。');
      } else {
        // Not an error: a suppressed send is the policy working.
        toast.warning('通知未發送', result.reason ?? result.messageZh);
      }
      setTestTemplate(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toast.warning('通知未發送', err.displayMessage);
        setTestTemplate(null);
      } else {
        toast.error('發送失敗', err instanceof ApiError ? err.displayMessage : '請稍後再試。');
      }
    } finally {
      setBusy(false);
    }
  };

  const insertVariable = (variable: string) => {
    if (!draft) return;
    const field = focusedField.current;
    setDraft({ ...draft, [field]: `${draft[field]}{{${variable}}}` });
  };

  // ---------------------------------------------------------------------

  const logColumns: Column<(typeof notifications)[number]>[] = [
    {
      key: 'recipient',
      header: '收件者',
      primary: true,
      sortValue: (row) => row.recipientName,
      cell: (row) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{row.recipientName}</p>
          <p className="truncate text-xs text-muted-foreground">關於 {row.userName}</p>
        </div>
      ),
    },
    {
      key: 'channel',
      header: '管道',
      sortValue: (row) => row.channel,
      cell: (row) => {
        const Icon = CHANNEL_ICONS[row.channel] ?? Bell;
        return (
          <Badge variant="muted" className="text-[10px]">
            <Icon className="size-3" />
            {CHANNEL_ZH[row.channel] ?? row.channel}
          </Badge>
        );
      },
    },
    {
      key: 'message',
      header: '內容',
      cell: (row) => (
        <div className="min-w-0 max-w-md">
          <p className="truncate text-sm">{row.title}</p>
          <p className="truncate text-xs text-muted-foreground">{row.body}</p>
        </div>
      ),
    },
    {
      key: 'read',
      header: '狀態',
      sortValue: (row) => (row.read ? 1 : 0),
      cell: (row) =>
        row.read ? (
          <Badge variant="muted" className="text-[10px]">
            已讀
          </Badge>
        ) : (
          <Badge variant="default" className="text-[10px]">
            未讀
          </Badge>
        ),
    },
    {
      key: 'time',
      header: '時間',
      sortValue: (row) => new Date(row.createdAt).getTime(),
      cell: (row) => <span className="text-xs text-muted-foreground">{timeAgo(row.createdAt)}</span>,
    },
  ];

  if (loading) {
    return (
      <div className="space-y-6">
        <PageHeader title="通知中心" description="載入中…" />
        <Skeleton className="h-96" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="通知中心" />
        <EmptyState
          icon={AlertTriangle}
          title="無法載入通知中心"
          description={error}
          action={<Button onClick={() => void load()}>重試</Button>}
        />
      </div>
    );
  }

  const enabledCount = templates.filter((t) => t.enabled).length;
  const unread = notifications.filter((n) => !n.read).length;

  return (
    <div className="space-y-6">
      <PageHeader
        title="通知中心"
        description="管理系統發出的通知內容與管道。編輯範本會直接改變照護者收到的文字。"
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="啟用的範本" value={`${enabledCount} / ${templates.length}`} icon={Bell} tone="primary" />
        <StatCard
          label="已停用範本"
          value={templates.length - enabledCount}
          icon={BellOff}
          tone={templates.length - enabledCount > 0 ? 'medium' : 'neutral'}
          sublabel="停用的類型完全不會發送"
        />
        <StatCard label="通知紀錄" value={notifications.length} icon={Send} tone="neutral" />
        <StatCard label="未讀" value={unread} icon={CheckCheck} tone={unread > 0 ? 'medium' : 'low'} />
      </div>

      <Tabs defaultValue="templates">
        <TabsList>
          <TabsTrigger value="templates">通知範本</TabsTrigger>
          <TabsTrigger value="log">發送紀錄</TabsTrigger>
        </TabsList>

        {/* --------------------------- Templates --------------------------- */}
        <TabsContent value="templates" className="space-y-3">
          {templates.map((template) => (
            <Card key={template.key} className={cn(!template.enabled && 'opacity-70')}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle className="text-base">{template.nameZh}</CardTitle>
                      <Badge variant="muted" className="font-mono text-[10px]">
                        {template.key}
                      </Badge>
                      {!template.enabled && (
                        <Badge variant="warning" className="text-[10px]">
                          <BellOff className="size-3" />
                          已停用
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="mt-1">
                      發送管道：
                      {template.channels.map((c) => CHANNEL_ZH[c] ?? c).join('、')}
                    </CardDescription>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {editable && (
                      <>
                        <Switch
                          checked={template.enabled}
                          disabled={busy}
                          onCheckedChange={() => void toggleEnabled(template)}
                          aria-label={`${template.enabled ? '停用' : '啟用'} ${template.nameZh}`}
                        />
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setDraft({
                              key: template.key,
                              title: template.title,
                              titleZh: template.titleZh,
                              body: template.body,
                              bodyZh: template.bodyZh,
                              channels: [...template.channels],
                              enabled: template.enabled,
                            });
                            setFieldErrors({});
                          }}
                        >
                          編輯
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setTestTemplate(template.key)}>
                          <Send />
                          測試
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </CardHeader>

              <CardContent>
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <p className="text-sm font-medium">{template.titleZh}</p>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {template.bodyZh}
                  </p>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">
                  最後更新：{timeAgo(template.updatedAt)}
                </p>
              </CardContent>
            </Card>
          ))}

          <Card className="border-dashed shadow-none">
            <CardContent className="flex items-start gap-3 p-4">
              <Variable className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="text-xs leading-relaxed text-muted-foreground">
                <p className="mb-1.5 font-medium text-foreground">可用的變數</p>
                <div className="flex flex-wrap gap-1.5">
                  {variables.map((variable) => (
                    <span
                      key={variable.key}
                      className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                      title={variable.descriptionZh}
                    >
                      {`{{${variable.key}}}`}
                    </span>
                  ))}
                </div>
                <p className="mt-2">
                  若輸入了不存在的變數，系統會原樣保留 <code>{'{{...}}'}</code>{' '}
                  而不是留下空白，讓打錯的地方一眼可見。
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ------------------------------ Log ------------------------------ */}
        <TabsContent value="log">
          {notifications.length === 0 ? (
            <EmptyState
              icon={BellOff}
              title="尚無發送紀錄"
              description="當長者的風險等級變化時，系統會依範本與政策自動發送通知。"
            />
          ) : (
            <DataTable
              rows={notifications}
              columns={logColumns}
              getRowKey={(row) => row.id}
              searchPlaceholder="搜尋收件者、長者或內容…"
              searchFields={(row) =>
                `${row.recipientName} ${row.userName} ${row.title} ${row.body} ${row.templateKey}`
              }
              initialSort={{ key: 'time', direction: 'desc' }}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* ---------------------------- Edit dialog -------------------------- */}
      <Dialog open={Boolean(draft)} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent wide>
          <DialogHeader>
            <DialogTitle>編輯通知範本</DialogTitle>
            <DialogDescription>
              儲存後，系統之後發出的此類通知都會使用新的文字。右側為以目前實際資料產生的預覽。
            </DialogDescription>
          </DialogHeader>

          {draft && (
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-4">
                <Field label="標題（中文）" required error={fieldErrors.titleZh}>
                  <Input
                    value={draft.titleZh}
                    onFocus={() => (focusedField.current = 'titleZh')}
                    onChange={(e) => setDraft({ ...draft, titleZh: e.target.value })}
                  />
                </Field>

                <Field label="內容（中文）" required error={fieldErrors.bodyZh}>
                  <Textarea
                    rows={5}
                    value={draft.bodyZh}
                    onFocus={() => (focusedField.current = 'bodyZh')}
                    onChange={(e) => setDraft({ ...draft, bodyZh: e.target.value })}
                  />
                </Field>

                <Field label="標題（英文）" required error={fieldErrors.title}>
                  <Input
                    value={draft.title}
                    onFocus={() => (focusedField.current = 'title')}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                  />
                </Field>

                <Field label="內容（英文）" required error={fieldErrors.body}>
                  <Textarea
                    rows={4}
                    value={draft.body}
                    onFocus={() => (focusedField.current = 'body')}
                    onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  />
                </Field>

                <div>
                  <Label className="mb-1.5 block">插入變數</Label>
                  <div className="flex flex-wrap gap-1.5">
                    {variables.map((variable) => (
                      <button
                        key={variable.key}
                        type="button"
                        onClick={() => insertVariable(variable.key)}
                        title={variable.descriptionZh}
                        className="rounded border border-border bg-muted px-2 py-1 font-mono text-[11px] transition-colors hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {`{{${variable.key}}}`}
                      </button>
                    ))}
                  </div>
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    會插入到最後點選的欄位。
                  </p>
                </div>

                <div>
                  <Label className="mb-1.5 block">發送管道</Label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_CHANNELS.map((channel) => {
                      const Icon = CHANNEL_ICONS[channel];
                      const selected = draft.channels.includes(channel);
                      return (
                        <button
                          key={channel}
                          type="button"
                          aria-pressed={selected}
                          onClick={() =>
                            setDraft({
                              ...draft,
                              channels: selected
                                ? draft.channels.filter((c) => c !== channel)
                                : [...draft.channels, channel],
                            })
                          }
                          className={cn(
                            'flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors',
                            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                            selected
                              ? 'border-primary bg-primary-muted text-primary'
                              : 'border-border hover:bg-accent',
                          )}
                        >
                          <Icon className="size-3.5" />
                          {CHANNEL_ZH[channel]}
                        </button>
                      );
                    })}
                  </div>
                  {fieldErrors.channels && (
                    <p role="alert" className="mt-1 text-xs font-medium text-destructive">
                      {fieldErrors.channels}
                    </p>
                  )}
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg bg-muted p-3">
                  <div>
                    <Label htmlFor="template-enabled">啟用此範本</Label>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      停用後，此類型的通知完全不會發送。
                    </p>
                  </div>
                  <Switch
                    id="template-enabled"
                    checked={draft.enabled}
                    onCheckedChange={(v) => setDraft({ ...draft, enabled: v })}
                  />
                </div>
              </div>

              {/* ------------------------ Preview ------------------------- */}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <Label>實際預覽</Label>
                  <Select value={testUserId} onValueChange={setTestUserId}>
                    <SelectTrigger className="h-8 w-auto min-w-[130px]" aria-label="預覽對象">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {residents.slice(0, 20).map((resident) => (
                        <SelectItem key={resident.id} value={resident.id}>
                          {resident.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="rounded-xl border border-border bg-card p-4 shadow-card">
                  <div className="flex items-start gap-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                      <Bell className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold">
                        {preview?.titleZh ?? '（正在產生預覽…）'}
                      </p>
                      <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                        {preview?.bodyZh ?? ''}
                      </p>
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        AI 守護高齡者 · 剛剛
                      </p>
                    </div>
                  </div>
                </div>

                <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
                  預覽使用這位長者目前的真實感測數值代入變數，因此您看到的就是照護者會收到的文字。
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              取消
            </Button>
            <Button onClick={save} loading={busy}>
              儲存範本
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------------------- Test dialog -------------------------- */}
      <Dialog open={Boolean(testTemplate)} onOpenChange={(open) => !open && setTestTemplate(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>發送測試通知</DialogTitle>
            <DialogDescription>
              這會實際發送一則通知給該長者的照護者，並顯示在發送紀錄中。
            </DialogDescription>
          </DialogHeader>

          <Field label="以哪位長者的資料發送" required>
            <Select value={testUserId} onValueChange={setTestUserId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {residents.slice(0, 30).map((resident) => (
                  <SelectItem key={resident.id} value={resident.id}>
                    {resident.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
            若通知因長者未授權、照護者的最低通知等級、勿擾時段或冷卻時間而未發送，系統會明確告訴您是哪一項條件擋下的，而不是回報成功。
          </p>

          <DialogFooter>
            <Button variant="outline" onClick={() => setTestTemplate(null)}>
              取消
            </Button>
            <Button onClick={sendTest} loading={busy}>
              <Send />
              發送
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
