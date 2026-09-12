/**
 * Static-build notice.
 *
 * The full application runs its risk engine on a server and pushes results to
 * every client. The GitHub Pages build cannot do that, so it runs the same
 * engine inside the tab instead. Several screens describe the server-push
 * behaviour in their copy, which would be a false claim here if left
 * unqualified — this banner states plainly what is actually running.
 *
 * Dismissible, and the choice is remembered, so it does not nag during a demo.
 */

import * as React from 'react';
import { Info, X } from 'lucide-react';
import { STATIC_DEMO } from '@/lib/api';
import { cn } from '@/lib/utils';

const DISMISSED_KEY = 'heatguard.staticNoticeDismissed';

export function StaticDemoBanner() {
  const [dismissed, setDismissed] = React.useState(() => {
    try {
      return localStorage.getItem(DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  });

  if (!STATIC_DEMO || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, 'true');
    } catch {
      /* storage disabled */
    }
    setDismissed(true);
  };

  return (
    <div
      role="note"
      className={cn(
        'flex items-start gap-2.5 border-b border-risk-medium-border bg-risk-medium-bg',
        'px-4 py-2 text-xs leading-relaxed text-risk-medium sm:px-6',
      )}
    >
      <Info className="mt-0.5 size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">
        <strong className="font-semibold">靜態示範版本。</strong>{' '}
        此版本託管於 GitHub Pages，沒有後端伺服器：風險引擎與模擬時鐘完全在您的瀏覽器中執行。功能與完整版相同，但
        <strong className="font-medium">重新整理頁面會將資料重設</strong>
        ，且不同瀏覽器之間不會同步。完整版的伺服器架構請見原始碼與 README。
      </p>
      <button
        type="button"
        onClick={dismiss}
        aria-label="關閉此說明"
        className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
