/**
 * Demo control panel.
 *
 * Drives the server-side scenario clock. Because the clock lives on the
 * server, starting a scenario here changes what every connected browser
 * shows - the CMS, the caregiver dashboard and the resident app move
 * together, which is the point of the demo.
 */

import * as React from 'react';
import { Gauge, Pause, Play, RotateCcw, Sparkles, Thermometer } from 'lucide-react';

import { api, ApiError, type ScenarioInfo } from '@/lib/api';
import { useLiveStore } from '@/store/live';
import { useToast } from '@/components/Toast';
import { cn } from '@/lib/utils';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Label,
  Progress,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Separator,
  Slider,
} from '@/components/ui';

const PHASE_ORDER = ['NORMAL', 'HEAT_INCREASING', 'MEDIUM_RISK', 'HIGH_RISK', 'RECOVERY'] as const;

const PHASE_ZH: Record<string, string> = {
  NORMAL: '正常',
  HEAT_INCREASING: '熱度上升',
  MEDIUM_RISK: '中度風險',
  HIGH_RISK: '高風險',
  RECOVERY: '風險下降',
};

export function DemoControls({ compact = false }: { compact?: boolean }) {
  const toast = useToast();
  const simulation = useLiveStore((s) => s.simulation);
  const stats = useLiveStore((s) => s.stats);

  const [open, setOpen] = React.useState(false);
  const [scenarios, setScenarios] = React.useState<ScenarioInfo[]>([]);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open || scenarios.length > 0) return;
    api
      .getSimulation()
      .then((res) => setScenarios(res.scenarios))
      .catch(() => {
        // The panel still works without the catalogue; only the descriptions
        // are missing, so this is not worth interrupting the user for.
      });
  }, [open, scenarios.length]);

  const run = async (body: unknown, successMessage?: string) => {
    setBusy(true);
    try {
      await api.simulationCommand(body);
      if (successMessage) toast.success(successMessage);
    } catch (error) {
      const message =
        error instanceof ApiError ? error.displayMessage : '無法執行模擬指令，請稍後再試。';
      toast.error('模擬指令失敗', message);
    } finally {
      setBusy(false);
    }
  };

  const startFullDemo = () =>
    run(
      { action: 'start', scenario: 'FULL_DEMO', focusUserId: 'user-001' },
      '已開始完整示範情境：王奶奶的熱風險將由低升至高，再回到低。',
    );

  const activePhaseIndex = simulation ? PHASE_ORDER.indexOf(simulation.phase) : -1;
  const isRunningScenario = Boolean(
    simulation?.scenario && simulation.scenario !== 'AMBIENT' && simulation.running,
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={isRunningScenario ? 'default' : 'outline'}
          size={compact ? 'sm' : 'default'}
          className={cn(isRunningScenario && 'animate-pulse-soft')}
        >
          <Sparkles />
          <span className={compact ? 'sr-only sm:not-sr-only' : undefined}>
            {isRunningScenario ? '示範進行中' : '示範控制'}
          </span>
        </Button>
      </DialogTrigger>

      <DialogContent wide>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            示範控制台
          </DialogTitle>
          <DialogDescription>
            控制伺服器端的模擬時鐘。所有開啟中的畫面（長者介面、照護儀表板、管理後台）會同步變化，不需要重新整理。
          </DialogDescription>
        </DialogHeader>

        {/* ------------------------ Primary action ------------------------ */}
        <div className="rounded-xl border border-primary/25 bg-primary-muted/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-semibold">完整競賽示範</p>
              <p className="text-sm text-muted-foreground">
                正常 → 熱度上升 → 中度風險 → 高風險 → 風險下降，約 2.5 分鐘。
              </p>
            </div>
            <Button onClick={startFullDemo} loading={busy} size="lg">
              <Thermometer />
              開始模擬熱風險
            </Button>
          </div>

          {/* ------------------------ Phase progress ---------------------- */}
          {simulation && simulation.scenario !== 'AMBIENT' && (
            <div className="mt-4 space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium">
                  目前階段：{PHASE_ZH[simulation.phase] ?? simulation.phase}
                </span>
                <span className="tabular text-muted-foreground">
                  已進行 {Math.round(simulation.elapsedSec)} 秒
                </span>
              </div>

              <div className="flex gap-1">
                {PHASE_ORDER.map((phase, index) => (
                  <div key={phase} className="flex-1">
                    <div
                      className={cn(
                        'h-1.5 rounded-full transition-colors',
                        index < activePhaseIndex
                          ? 'bg-primary'
                          : index === activePhaseIndex
                            ? 'bg-primary/40'
                            : 'bg-muted',
                      )}
                    >
                      {index === activePhaseIndex && (
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-500"
                          style={{ width: `${simulation.phaseProgress * 100}%` }}
                        />
                      )}
                    </div>
                    <p
                      className={cn(
                        'mt-1 truncate text-center text-[10px]',
                        index === activePhaseIndex
                          ? 'font-semibold text-primary'
                          : 'text-muted-foreground',
                      )}
                    >
                      {PHASE_ZH[phase]}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <Separator />

        {/* --------------------------- Scenarios -------------------------- */}
        <div className="space-y-3">
          <Label>情境選擇</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {scenarios
              .filter((s) => s.name !== 'AMBIENT')
              .map((scenario) => (
                <button
                  key={scenario.name}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    run(
                      { action: 'start', scenario: scenario.name },
                      `已開始情境：${scenario.labelZh}`,
                    )
                  }
                  className={cn(
                    'rounded-lg border p-3 text-left transition-colors',
                    'hover:border-primary hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    simulation?.scenario === scenario.name
                      ? 'border-primary bg-primary-muted'
                      : 'border-border',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{scenario.labelZh}</span>
                    <span className="tabular text-[10px] text-muted-foreground">
                      {scenario.durationSec}s
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {scenario.description}
                  </p>
                </button>
              ))}
          </div>
        </div>

        <Separator />

        {/* ------------------------ Manual controls ----------------------- */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="sim-speed">
              速度倍率
              <span className="tabular ml-2 font-normal text-muted-foreground">
                {simulation?.speed.toFixed(2) ?? '1.00'}×
              </span>
            </Label>
            <Slider
              id="sim-speed"
              min={0.25}
              max={4}
              step={0.25}
              value={[simulation?.speed ?? 1]}
              onValueCommit={([speed]) => run({ action: 'set-speed', speed })}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">加速情境播放，方便縮短示範時間。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sim-temp">
              手動溫度偏移
              <span className="tabular ml-2 font-normal text-muted-foreground">
                {(simulation?.manualOffsets.tempC ?? 0) > 0 ? '+' : ''}
                {simulation?.manualOffsets.tempC.toFixed(1) ?? '0.0'}°C
              </span>
            </Label>
            <Slider
              id="sim-temp"
              min={-8}
              max={12}
              step={0.5}
              value={[simulation?.manualOffsets.tempC ?? 0]}
              onValueCommit={([tempC]) => run({ action: 'set-offsets', offsets: { tempC } })}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">直接調整室外溫度，觀察風險引擎的反應。</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="sim-humidity">
              手動濕度偏移
              <span className="tabular ml-2 font-normal text-muted-foreground">
                {(simulation?.manualOffsets.humidityPct ?? 0) > 0 ? '+' : ''}
                {simulation?.manualOffsets.humidityPct.toFixed(0) ?? '0'}%
              </span>
            </Label>
            <Slider
              id="sim-humidity"
              min={-30}
              max={30}
              step={1}
              value={[simulation?.manualOffsets.humidityPct ?? 0]}
              onValueCommit={([humidityPct]) =>
                run({ action: 'set-offsets', offsets: { humidityPct } })
              }
              disabled={busy}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="sim-hr">
              手動心率偏移
              <span className="tabular ml-2 font-normal text-muted-foreground">
                {(simulation?.manualOffsets.heartRateBpm ?? 0) > 0 ? '+' : ''}
                {simulation?.manualOffsets.heartRateBpm.toFixed(0) ?? '0'} BPM
              </span>
            </Label>
            <Slider
              id="sim-hr"
              min={-20}
              max={50}
              step={1}
              value={[simulation?.manualOffsets.heartRateBpm ?? 0]}
              onValueCommit={([heartRateBpm]) =>
                run({ action: 'set-offsets', offsets: { heartRateBpm } })
              }
              disabled={busy}
            />
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            onClick={() =>
              run(
                { action: simulation?.running ? 'stop' : 'start', scenario: simulation?.scenario ?? 'AMBIENT' },
                simulation?.running ? '已暫停模擬' : '已繼續模擬',
              )
            }
            loading={busy}
          >
            {simulation?.running ? <Pause /> : <Play />}
            {simulation?.running ? '暫停' : '繼續'}
          </Button>

          <Button
            variant="outline"
            onClick={() => run({ action: 'reset' }, '已重設模擬，所有長者回到初始狀態。')}
            loading={busy}
          >
            <RotateCcw />
            重設模擬
          </Button>

          {stats && (
            <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
              <Gauge className="size-4" />
              <span className="tabular">
                {stats.activeUsers} 位長者 · 高風險 {stats.highRiskUsers} · 需注意{' '}
                {stats.mediumRiskUsers}
              </span>
            </div>
          )}
        </div>

        <p className="rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          <strong className="font-semibold text-foreground">說明：</strong>
          此原型的所有感測數值皆為模擬產生，並未連接真實裝置。風險判讀、政策執行與通知流程則是真實運作的程式邏輯。
        </p>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The resident-facing version: one large button, no configuration.
 * A resident should never be shown scenario internals.
 */
export function SimulateRiskButton({ userId }: { userId: string }) {
  const toast = useToast();
  const simulation = useLiveStore((s) => s.simulation);
  const [busy, setBusy] = React.useState(false);

  const running = Boolean(
    simulation?.scenario && simulation.scenario !== 'AMBIENT' && simulation.running,
  );

  const start = async () => {
    setBusy(true);
    try {
      await api.simulationCommand({ action: 'start', scenario: 'FULL_DEMO', focusUserId: userId });
      toast.success('示範已開始', '接下來約 2 分鐘，您會看到熱風險由低升到高，再回到低。');
    } catch (error) {
      const message =
        error instanceof ApiError ? error.displayMessage : '無法開始示範，請稍後再試。';
      toast.error('無法開始示範', message);
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await api.simulationCommand({ action: 'reset' });
      toast.success('已回到初始狀態');
    } catch {
      toast.error('無法重設', '請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-wrap gap-2">
      <Button onClick={start} loading={busy} disabled={running}>
        <Thermometer />
        {running ? '示範進行中…' : '模擬熱風險'}
      </Button>
      {running && (
        <Button variant="outline" onClick={reset} loading={busy}>
          <RotateCcw />
          結束示範
        </Button>
      )}
    </div>
  );
}
