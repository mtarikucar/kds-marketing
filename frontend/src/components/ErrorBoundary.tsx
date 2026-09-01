import { Component, type ReactNode } from 'react';
import { Button } from './ui';

interface Props {
  children: ReactNode;
  /**
   * Replaces the generic panel. Given the boundary's own `retry`, so a caller
   * can name what failed and still offer the same recovery.
   *
   * The person surface uses it for one COLUMN of three: "Something went wrong"
   * across a whole screen is the right sentence for a route, and the wrong one
   * for an arrangement of the left column that a user can simply switch away
   * from — especially when the other two columns are still working.
   */
  fallback?: (retry: () => void) => ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Per-page error boundary. The audit flagged that a single failing query in a
 * child crashes the whole panel (white screen). This catches render errors and
 * shows a recoverable fallback instead, keeping the shell (sidebar/header)
 * alive. MarketingLayout keys it on the route so navigating away auto-clears it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // eslint-disable-next-line no-console
    console.error('UI error boundary caught:', error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      if (this.props.fallback) return <>{this.props.fallback(this.reset)}</>;
      return (
        <div className="flex min-h-[50vh] flex-col items-center justify-center gap-4 p-8 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-2xl font-bold text-red-600">
            !
          </div>
          <div>
            <h2 className="font-heading text-lg font-semibold text-slate-900">
              Something went wrong
            </h2>
            <p className="mt-1 max-w-sm text-sm text-slate-500">
              This page hit an unexpected error. You can retry, or reload the app.
            </p>
          </div>
          <div className="flex gap-2">
            <Button onClick={this.reset}>Retry</Button>
            <Button variant="outline" onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
