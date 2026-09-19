/**
 * Device pairing wizard.
 *
 * Connecting a sensor is four separate things that are easy to get out of
 * order: register the device, issue its credential, configure the thing in the
 * room, and confirm it is actually reporting. Done from the device table those
 * are four screens and a copied key on a sticky note.
 *
 * WHAT THIS REFUSES TO CALL "CONNECTED"
 * -------------------------------------
 * The last step waits for a real reading to arrive. Until one does, the wizard
 * says it is waiting - it does not congratulate anyone for submitting a form.
 * A pairing flow that reports success on registration is how you end up with a
 * roster full of devices nobody has ever heard from, which is precisely the
 * fiction this platform exists to avoid.
 */

import * as React from 'react';
import { Check, Copy, KeyRound, Loader2, Radio } from 'lucide-react';

import type { Device, DeviceType, ElderlyUser } from '@shared/types/domain';
import { api, ApiError } from '@/lib/api';
import { cn, DEVICE_LABELS_ZH } from '@/lib/utils';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui';

/** Sensor types only. An actuator reports nothing, so it has nothing to pair. */
const PAIRABLE_TYPES: DeviceType[] = [
  'TEMPERATURE_SENSOR',
  'HUMIDITY_SENSOR',
  'AIR_QUALITY_SENSOR',
  'SMART_WATCH',
];

/** Suggested placement per type, so the field is rarely left at a default. */
const DEFAULT_LOCATION: Record<string, string> = {
  TEMPERATURE_SENSOR: '客廳',
  HUMIDITY_SENSOR: '客廳',
  AIR_QUALITY_SENSOR: '客廳',
  SMART_WATCH: '隨身',
};

type Step = 'details' | 'key' | 'waiting' | 'done';

export function DevicePairingWizard({
  open,
  onOpenChange,
  residents,
  onPaired,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  residents: Pick<ElderlyUser, 'id' | 'name'>[];
  onPaired: () => void;
}) {
  const toast = useToast();

  const [step, setStep] = React.useState<Step>('details');
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  const [draft, setDraft] = React.useState({
    userId: '',
    type: 'TEMPERATURE_SENSOR' as DeviceType,
    deviceId: '',
    location: DEFAULT_LOCATION.TEMPERATURE_SENSOR,
  });

  const [device, setDevice] = React.useState<Device | null>(null);
  const [issuedKey, setIssuedKey] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<string | null>(null);

  /** Reset everything when the dialog closes, so the key never lingers. */
  const reset = () => {
    setStep('details');
    setDevice(null);
    setIssuedKey(null);
    setFieldError(null);
    setCopied(false);
    setDraft({
      userId: '',
      type: 'TEMPERATURE_SENSOR',
      deviceId: '',
      location: DEFAULT_LOCATION.TEMPERATURE_SENSOR,
    });
  };

  /**
   * Suggest a device id from the type and resident.
   *
   * Hand-typed ids drift into inconsistency across a roster of fifty homes,
   * and the id is what an engineer reads off a label when something breaks.
   */
  const suggestId = (type: DeviceType, userId: string) => {
    const prefix =
      type === 'TEMPERATURE_SENSOR'
        ? 'TEMP'
        : type === 'HUMIDITY_SENSOR'
          ? 'HUMI'
          : type === 'AIR_QUALITY_SENSOR'
            ? 'AIRQ'
            : 'WATCH';
    const digits = userId.replace(/\D/g, '').padStart(3, '0').slice(-3);
    return `HG-${prefix}-${digits}${Math.floor(Math.random() * 9) + 1}`;
  };

  // --- step 1 → 2 -----------------------------------------------------------
  const register = async () => {
    setFieldError(null);

    if (!draft.userId) {
      setFieldError('請先選擇要配對的長者。');
      return;
    }

    setBusy(true);
    try {
      const created = await api.createDevice({
        deviceId: draft.deviceId || suggestId(draft.type, draft.userId),
        name: draft.type,
        nameZh: DEVICE_LABELS_ZH[draft.type] ?? draft.type,
        type: draft.type,
        userId: draft.userId,
        location: draft.location,
        firmware: '1.0.0',
      });

      // Register and credential in one step: a registered sensor with no key
      // cannot report, and leaving it in that state is a half-finished job
      // somebody has to remember to come back to.
      const keyed = await api.issueIngestKey(created.device.id);

      setDevice(keyed.device);
      setIssuedKey(keyed.key);
      setStep('key');
    } catch (err) {
      setFieldError(err instanceof ApiError ? err.displayMessage : '註冊失敗，請稍後再試。');
    } finally {
      setBusy(false);
    }
  };

  // --- step 3: wait for the device to actually report -----------------------
  React.useEffect(() => {
    if (step !== 'waiting' || !device) return;

    let cancelled = false;

    const poll = async () => {
      try {
        const result = await api.getDevice(device.id);
        // lastIngestAt is only set when a reading really arrived. Nothing else
        // in the flow is allowed to declare success.
        if (!cancelled && result.device.lastIngestAt) {
          setDevice(result.device);
          setStep('done');
          onPaired();
        }
      } catch {
        // A failed poll is not a failed pairing; keep waiting.
      }
    };

    const timer = setInterval(() => void poll(), 2000);
    void poll();

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [step, device, onPaired]);

  const command = issuedKey
    ? `node tools/device-client/client.mjs --key ${issuedKey} --interval 10`
    : '';

  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Radio className="size-4" />
            連接新裝置
          </DialogTitle>
          <DialogDescription>
            註冊裝置、產生金鑰，並等待它真的傳回第一筆資料。
          </DialogDescription>
        </DialogHeader>

        <Steps step={step} />

        {/* ------------------------------ 1. details ---------------------- */}
        {step === 'details' && (
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">長者</Label>
              <Select
                value={draft.userId}
                onValueChange={(value) =>
                  setDraft((d) => ({ ...d, userId: value, deviceId: '' }))
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="選擇要配對的長者" />
                </SelectTrigger>
                <SelectContent>
                  {residents.map((r) => (
                    <SelectItem key={r.id} value={r.id}>
                      {r.name}（{r.id}）
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">裝置類型</Label>
                <Select
                  value={draft.type}
                  onValueChange={(value) =>
                    setDraft((d) => ({
                      ...d,
                      type: value as DeviceType,
                      location: DEFAULT_LOCATION[value] ?? d.location,
                      deviceId: '',
                    }))
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAIRABLE_TYPES.map((type) => (
                      <SelectItem key={type} value={type}>
                        {DEVICE_LABELS_ZH[type] ?? type}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs">位置</Label>
                <Input
                  value={draft.location}
                  onChange={(e) => setDraft((d) => ({ ...d, location: e.target.value }))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">裝置編號（留空則自動產生）</Label>
              <Input
                value={draft.deviceId}
                placeholder={
                  draft.userId ? suggestId(draft.type, draft.userId) : 'HG-TEMP-0011'
                }
                onChange={(e) =>
                  setDraft((d) => ({ ...d, deviceId: e.target.value.toUpperCase() }))
                }
                className="font-mono"
              />
            </div>

            {fieldError && <p className="text-xs text-risk-high">{fieldError}</p>}
          </div>
        )}

        {/* -------------------------------- 2. key ------------------------ */}
        {step === 'key' && issuedKey && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-lg border border-risk-medium-border bg-risk-medium-bg/40 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-risk-medium">
                <KeyRound className="size-3.5" />
                金鑰只會顯示這一次
              </p>
              <code className="block break-all rounded bg-card p-2 font-mono text-xs">
                {issuedKey}
              </code>
              <p className="text-[11px] text-muted-foreground">
                平台只保存金鑰的雜湊值，離開後無法再查看。遺失時重新產生即可，舊金鑰會同時失效。
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs">在裝置或閘道上執行</Label>
              <div className="flex gap-2">
                <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded bg-muted px-2 py-1.5 font-mono text-[11px]">
                  {command}
                </code>
                <Button size="sm" variant="outline" onClick={() => copy(command)}>
                  {copied ? <Check className="text-risk-low" /> : <Copy />}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                若使用 MQTT 感測器，請改將金鑰填入 tools/mqtt-bridge/mapping.json。
              </p>
            </div>
          </div>
        )}

        {/* ------------------------------ 3. waiting ---------------------- */}
        {step === 'waiting' && device && (
          <div className="space-y-3 py-2 text-center">
            <Loader2 className="mx-auto size-6 animate-spin text-muted-foreground" />
            <p className="text-sm font-medium">等待 {device.deviceId} 傳回第一筆資料…</p>
            <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
              在裝置真的回報之前，這裡不會顯示「已連接」。
              一個從未傳過資料的裝置留在名冊上，比沒有這個裝置更糟。
            </p>
          </div>
        )}

        {/* -------------------------------- 4. done ----------------------- */}
        {step === 'done' && device && (
          <div className="space-y-3 py-2 text-center">
            <span className="mx-auto flex size-10 items-center justify-center rounded-full bg-risk-low-bg">
              <Check className="size-5 text-risk-low" />
            </span>
            <p className="text-sm font-semibold">{device.deviceId} 已連接</p>
            <p className="mx-auto max-w-sm text-xs leading-relaxed text-muted-foreground">
              此裝置的數值現在來自實機回報。
              若它日後停止回報，畫面會顯示最後一次讀值並標示為離線，
              <strong className="font-semibold text-foreground">不會</strong>改用模擬值填補。
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'details' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button onClick={() => void register()} loading={busy}>
                註冊並產生金鑰
              </Button>
            </>
          )}

          {step === 'key' && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                稍後再設定
              </Button>
              <Button onClick={() => setStep('waiting')}>已設定好，開始等待</Button>
            </>
          )}

          {step === 'waiting' && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              在背景等待
            </Button>
          )}

          {step === 'done' && (
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              完成
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The four steps, so it is obvious that pairing is not finished at step two. */
function Steps({ step }: { step: Step }) {
  const order: Step[] = ['details', 'key', 'waiting', 'done'];
  const labels: Record<Step, string> = {
    details: '裝置資料',
    key: '金鑰',
    waiting: '等待回報',
    done: '完成',
  };

  const current = order.indexOf(step);

  return (
    <div className="flex items-center gap-1.5">
      {order.map((s, i) => (
        <React.Fragment key={s}>
          <Badge
            variant={i < current ? 'success' : i === current ? 'default' : 'muted'}
            className={cn('text-[10px]', i > current && 'opacity-60')}
          >
            {i + 1}. {labels[s]}
          </Badge>
          {i < order.length - 1 && <span className="h-px w-2 bg-border" />}
        </React.Fragment>
      ))}
    </div>
  );
}
