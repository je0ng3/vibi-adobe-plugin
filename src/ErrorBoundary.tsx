import { Component, type ErrorInfo, type ReactNode } from "react";

// Class-based error boundary. Without it, a throw during render/lifecycle anywhere in the tree
// (e.g. a malformed server payload reaching ScriptEditor/StemListView) unmounts the whole panel
// and leaves it permanently blank — the "plugin crashed on my machine" failure an Adobe reviewer
// would hit. main.tsx's try/catch only guards the initial synchronous render, not later
// re-render throws, so we need this too. The full stack is shown only in diag/UDT builds
// (__VIBI_DIAG__); a shipped build shows a plain recoverable message.
type Props = { children: ReactNode };
type State = { error: Error | null };

function diagOn(): boolean {
  return (globalThis as { __VIBI_DIAG__?: boolean }).__VIBI_DIAG__ === true;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Dropped from prod bundles by the console strip; useful in dev/UDT.
    console.error("[boundary] render crashed:", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    // Plain DOM (no Spectrum custom elements) so the fallback renders even if the crash was
    // theme/component related.
    return (
      <div style={{ padding: 16, color: "#ddd", font: "13px sans-serif" }}>
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Something went wrong</p>
        <p>The panel hit an unexpected error. Please close and reopen the Vibi: AI Sound Eraser panel.</p>
        {diagOn() && (
          <pre style={{ color: "#f88", whiteSpace: "pre-wrap", font: "11px monospace", marginTop: 8 }}>
            {`${error.message}\n${error.stack ?? ""}`}
          </pre>
        )}
      </div>
    );
  }
}
