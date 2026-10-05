import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(error, info);
    document.getElementById("boot-splash")?.remove();
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: 24, color: "#f87171", background: "#1e1e1e", height: "100vh", fontFamily: "Segoe UI, sans-serif" }}>
          <h2 style={{ color: "#fff" }}>DataRefine Studio hit an error</h2>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{String(this.state.error.stack || this.state.error)}</pre>
          <button
            style={{ marginTop: 12, padding: "6px 12px" }}
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
