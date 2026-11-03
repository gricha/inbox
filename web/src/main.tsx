import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "./styles.css";

const KEY = "desk.crash_reload_at";

// A render error would leave the window blank (a hot update that changes state shapes does it): reload instead, unless
// the page just came back from a reload and broke again.
class Reload extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
    let last = 0;
    try {
      last = Number(sessionStorage.getItem(KEY)) || 0;
      sessionStorage.setItem(KEY, String(Date.now()));
    } catch {}
    if (Date.now() - last > 10_000) location.reload();
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crashed">
        <p>Review Desk hit an error: {this.state.error.message}</p>
        <button
          type="button"
          onClick={() => {
            location.reload();
          }}
        >
          Reload
        </button>
      </div>
    );
  }
}

createRoot(document.querySelector("#root")!).render(
  <StrictMode>
    <Reload>
      <App />
    </Reload>
  </StrictMode>,
);
