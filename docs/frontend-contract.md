# Frontend contract

Read this before writing any page. It exists so that pages built independently
still look and behave like one product.

## Non-negotiables

1. **No business logic in pages.** Risk levels, scores, actions, explanations
   and blocked-action reasons are all computed on the server and arrive
   ready-made. Never recompute a threshold, never re-derive a level from a
   heat index, never decide client-side whether cooling should be on. If you
   need a number that isn't in the payload, it belongs on the server.
2. **No hard-coded thresholds or weights.** `27`, `32`, `39` must never appear
   in a page. Read them from the live config (`useLiveStore` / `api.getRiskRules`).
3. **No fake functionality.** Every button navigates, opens a dialog, mutates
   state, or calls the API. No `TODO`, no "coming soon", no placeholder cards,
   no chart fed by a literal array. If something cannot be wired, don't build it.
4. **Colour never carries meaning alone.** Every risk indicator pairs colour
   with an icon and a text label. Use the shared components below rather than
   colouring text yourself.
5. **Every failure state is handled.** Loading, empty, error, and
   permission-denied each need a real rendering. Never show a raw error object.
6. **Traditional Chinese is the interface language.** English appears only as a
   secondary label where the brief specifies it (risk levels, action names).

## Information hierarchy

Every significant screen follows: **STATUS → WHY → ACTION**.
The resident dashboard answers, in this order: 目前安全嗎 → 為什麼 → 我該做什麼.

## Data access

### Live data (preferred — updates every ~2s with no refetch)

```ts
import { useLiveStore, selectAssessment, selectSmartHome, selectHistory,
         selectUserDevices, selectOpenAlerts } from '@/store/live';

const assessment = useLiveStore(selectAssessment(userId)); // RiskAssessment | null
const smartHome  = useLiveStore(selectSmartHome(userId));
const history    = useLiveStore(selectHistory(userId));    // RiskHistoryPoint[]
const stats      = useLiveStore((s) => s.stats);           // PlatformStats | null
const cityRisk   = useLiveStore((s) => s.cityRisk);
const alerts     = useLiveStore((s) => s.alerts);
const devices    = useLiveStore((s) => s.devices);
const simulation = useLiveStore((s) => s.simulation);
const connection = useLiveStore((s) => s.connection);
```

**Use the live store for anything that changes.** Only fetch via `api.*` for
data the socket does not carry (user detail, cooling spaces, content, audit
log, settings, templates, data sources, system health).

### Session

```ts
import { useSession } from '@/store/session';
const { account, elderlyUser, caregiver, elderMode, can } = useSession();
const focusUserId = useSession((s) => s.focusUserId()); // resident being viewed
if (can('risk-rule:write')) { /* render the editing control */ }
```

Gate every mutating control behind `can(...)`. A VIEWER must see the data and
not the buttons. The server enforces this independently — hiding is courtesy.

### API + errors

```ts
import { api, ApiError } from '@/lib/api';
import { useToast } from '@/components/Toast';

const toast = useToast();
try {
  await api.updateRiskRules({ thresholds: { medium: 33 } });
  toast.success('已更新風險門檻', '所有畫面已同步套用新的設定。');
} catch (error) {
  const message = error instanceof ApiError ? error.displayMessage : '請稍後再試。';
  toast.error('更新失敗', message);
}
```

`ApiError.fieldErrors` is `{ 'thresholds.medium': '…' }` — feed it to `<Field error={...}>`.

## Components you must use (do not rebuild these)

From `@/components/ui`:
`Button Card CardHeader CardTitle CardDescription CardContent CardFooter Badge
Input Textarea Label Field Switch Checkbox Slider Progress Separator Skeleton
Dialog DialogContent DialogHeader DialogTitle DialogDescription DialogFooter
DialogTrigger DialogClose Tabs TabsList TabsTrigger TabsContent
Select SelectTrigger SelectValue SelectContent SelectItem
Tooltip TooltipTrigger TooltipContent InfoTip
DropdownMenu DropdownMenuTrigger DropdownMenuContent DropdownMenuItem
DropdownMenuLabel DropdownMenuSeparator`

From `@/components/domain/RiskIndicators`:
`RiskBadge RiskIcon RiskScoreDial RiskFactorList TrendIcon MetricTile
StatusIndicator LiveIndicator RiskSummaryStrip EmptyState`

From `@/components/domain/Cards`:
`AIExplanationCard BaselineCard ActionList SmartHomeCard DeviceCard
CoolingSpaceCard AlertCard CaregiverStatusCard StatCard PageHeader`

From `@/components/domain/Charts`:
`ChartCard RiskTimeline EnvironmentChart HumidityChart HeartRateChart
RiskDistributionChart Sparkline CoolingEffectivenessChart`

From `@/components/domain/DataTable`: `DataTable` + `Column<T>` type.
From `@/components/domain/HeatMap`: `HeatMap MapLegend LayerControls DEFAULT_LAYERS MapLayers`.
From `@/components/domain/DemoControls`: `DemoControls SimulateRiskButton`.

Helpers from `@/lib/utils`: `cn RISK_STYLES formatTemp formatPct formatNumber
formatTime formatDateTime timeAgo formatDistance initials DEVICE_LABELS_ZH
DEVICE_STATUS_ZH RELATIONSHIP_ZH CHANNEL_ZH ALERT_STATUS_ZH CONTENT_CATEGORY_ZH`.

Icons: `lucide-react`. Animation: `framer-motion` (sparingly, and respect
`prefers-reduced-motion` — the CSS already does this globally).

## Page skeleton

```tsx
import { PageHeader } from '@/components/domain/Cards';

export default function SomePage() {
  return (
    <div className="space-y-6">
      <PageHeader title="標題" description="一句話說明這個頁面在做什麼。" actions={…} />
      {/* content */}
    </div>
  );
}
```

Pages are rendered inside a layout that already provides padding, the header
and navigation. Do not add your own page chrome or `min-h-screen`.

## Loading / empty / error patterns

```tsx
if (loading) return <div className="space-y-4">{/* <Skeleton/> blocks */}</div>;
if (error)   return <EmptyState icon={AlertTriangle} title="無法載入資料" description={error} action={<Button onClick={reload}>重試</Button>} />;
if (rows.length === 0) return <EmptyState icon={Inbox} title="目前沒有資料" description="…" />;
```

Never render `{error.message}` from an unknown object — use `ApiError.displayMessage`.

## Responsive rules

- Grids: `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` — single column on mobile.
- `DataTable` already collapses to cards below `md`. Use it for every list.
- Touch targets ≥ 44px. Elderly mode is handled by the `.elder-mode` class on
  the layout; use `size="elder"` on primary buttons in resident-facing flows
  when `elderMode` is true.
- Charts sit inside `ChartCard`, which handles sizing.

## Accessibility checklist per page

- One `<h1>` via `PageHeader`; section headings descend in order.
- Every icon-only button has `aria-label`.
- Every form control has a `<Label>` or is wrapped in `<Field>`.
- Live regions: values that change on their own need `aria-live="polite"` on a
  wrapping element, or rely on `LiveIndicator` which already announces.
- Tables: `DataTable` handles `scope` and `aria-sort`.

## Verify before you finish

```bash
npx tsc --noEmit -p tsconfig.json
```

Must report zero errors. Do **not** run `vite build` or start a dev server —
other agents are working in the same tree concurrently.

## Tone of copy

Calm, plain, respectful. Address the resident directly (您). Never diagnose:
write 「熱風險升高」 or 「建議採取降溫措施」, never 「你已經中暑」. State what the
system did and why, including when it deliberately did nothing.
