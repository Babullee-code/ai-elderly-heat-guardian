/**
 * Toast notifications.
 *
 * Every mutating action in the product confirms what happened - including
 * when it did NOT happen. A refused action (permission denied, notification
 * suppressed by policy) shows the reason rather than failing silently, which
 * is how the CMS teaches an admin what their switches actually do.
 */

import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

export type ToastTone = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
}

interface ToastContextValue {
  toast: (input: Omit<Toast, 'id'>) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  warning: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>');
  return ctx;
}

const TONES: Record<
  ToastTone,
  { icon: React.ComponentType<{ className?: string }>; ring: string; iconColor: string }
> = {
  success: { icon: CheckCircle2, ring: 'border-risk-low-border', iconColor: 'text-risk-low' },
  error: { icon: XCircle, ring: 'border-risk-high-border', iconColor: 'text-risk-high' },
  warning: { icon: AlertTriangle, ring: 'border-risk-medium-border', iconColor: 'text-risk-medium' },
  info: { icon: Info, ring: 'border-border', iconColor: 'text-primary' },
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const nextId = React.useRef(1);

  const dismiss = React.useCallback((id: number) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const toast = React.useCallback(
    (input: Omit<Toast, 'id'>) => {
      const id = nextId.current++;
      setToasts((current) => [...current.slice(-3), { ...input, id }]);

      // Errors stay longer: they usually carry a reason the user needs to read.
      const timeout = input.tone === 'error' ? 7000 : 4500;
      setTimeout(() => dismiss(id), timeout);
    },
    [dismiss],
  );

  const value = React.useMemo<ToastContextValue>(
    () => ({
      toast,
      success: (title, description) => toast({ tone: 'success', title, description }),
      error: (title, description) => toast({ tone: 'error', title, description }),
      warning: (title, description) => toast({ tone: 'warning', title, description }),
      info: (title, description) => toast({ tone: 'info', title, description }),
    }),
    [toast],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2 sm:bottom-6 sm:right-6"
        role="region"
        aria-label="通知訊息"
      >
        {toasts.map((item) => {
          const tone = TONES[item.tone];
          const Icon = tone.icon;

          return (
            <div
              key={item.id}
              // Errors and warnings interrupt; successes are announced politely.
              role={item.tone === 'error' || item.tone === 'warning' ? 'alert' : 'status'}
              aria-live={item.tone === 'error' || item.tone === 'warning' ? 'assertive' : 'polite'}
              className={cn(
                'pointer-events-auto flex items-start gap-3 rounded-xl border bg-card p-4 shadow-panel',
                'animate-slide-up',
                tone.ring,
              )}
            >
              <Icon className={cn('mt-0.5 size-5 shrink-0', tone.iconColor)} aria-hidden />

              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium leading-snug">{item.title}</p>
                {item.description && (
                  <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                    {item.description}
                  </p>
                )}
              </div>

              <button
                type="button"
                onClick={() => dismiss(item.id)}
                className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label="關閉通知"
              >
                <X className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}
