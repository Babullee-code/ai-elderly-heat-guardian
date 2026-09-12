/**
 * Error boundary.
 *
 * A rendering failure in one panel must not take down a safety dashboard.
 * The fallback explains what happened in plain language and offers a way
 * forward - it never shows a raw stack trace to a resident or a caregiver.
 * The technical detail stays available behind a disclosure for a developer.
 */

import * as React from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card, CardContent } from '@/components/ui';

interface Props {
  children: React.ReactNode;
  /** Short label for the area that failed, e.g. "熱風險地圖". */
  area?: string;
  fallback?: React.ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[ui] Render error', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    if (this.props.fallback) return this.props.fallback;

    return (
      <Card className="border-risk-medium-border bg-risk-medium-bg/40">
        <CardContent className="flex flex-col items-start gap-3 p-6">
          <div className="flex items-center gap-2 text-risk-medium">
            <AlertTriangle className="size-5" />
            <p className="font-semibold">
              {this.props.area ? `${this.props.area}目前無法顯示` : '這個區塊目前無法顯示'}
            </p>
          </div>

          <p className="text-sm text-muted-foreground">
            系統其他部分仍在正常運作。您可以重新載入這個區塊，若問題持續發生請聯繫系統管理者。
          </p>

          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={this.reset}>
              <RefreshCw className="size-4" />
              重新載入
            </Button>
          </div>

          {import.meta.env.DEV && (
            <details className="w-full">
              <summary className="cursor-pointer text-xs text-muted-foreground">
                技術細節（僅開發模式顯示）
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-muted p-3 text-xs">
                {error.message}
              </pre>
            </details>
          )}
        </CardContent>
      </Card>
    );
  }
}
