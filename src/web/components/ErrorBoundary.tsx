import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  /** Changing this (the route) clears a caught error, so navigating away recovers the page. */
  resetKey: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  key: string;
}

/**
 * A render error in one page must never blank the whole app. It shows the message, a retry and a reload instead.
 * React unmounts the whole tree on an uncaught render error, which is what a null `.toLowerCase()` once did to the run page.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("page crashed:", error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) {
      return this.props.children;
    }
    return (
      <div className="page-error" role="alert">
        <h2>This page failed to render</h2>
        <p className="muted">{this.state.error.message}</p>
        <div className="page-error-actions">
          <button className="btn" type="button" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
          <button className="btn" type="button" onClick={() => location.reload()}>
            Reload
          </button>
          <a className="btn" href="#/">
            Back to runs
          </a>
        </div>
      </div>
    );
  }
}
