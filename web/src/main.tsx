import { Component, StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { reactErrors } from "./sentry.ts";
import { getStored, setStored } from "./storage.ts";
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
    const last = Number(getStored(KEY, true)) || 0; // storage off: it can't tell a second crash, so it reloads
    setStored(KEY, String(Date.now()), true);
    if (Date.now() - last > 10_000) location.reload();
  }

  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="crashed">
        <p>Inbox hit an error: {this.state.error.message}</p>
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

createRoot(document.querySelector("#root")!, reactErrors).render(
  <StrictMode>
    <Reload>
      <App />
    </Reload>
  </StrictMode>,
);
