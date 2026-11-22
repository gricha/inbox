// Settings → MCP servers: your agent's own, where its config keeps them and which automations name each; checked, added
// and removed through its own CLI (src/agents.ts). An automation names these to read through them.
import { Effect } from "effect";
import { useState, type SubmitEvent } from "react";
import type { McpServer, McpView } from "../../../src/types.ts";
import { api, runUi } from "../api.ts";
import { cls } from "../format.ts";
import { useKeyed } from "../keyed.ts";
import { withCode } from "./Prose.tsx";
import { SkLines } from "./Skeleton.tsx";

const STATE: Record<NonNullable<McpServer["status"]>["state"], string> = {
  connected: "Connected",
  "needs-auth": "Needs sign-in",
  failed: "Can't connect",
};

// A server's second line: where it is, its headers, who uses it, and after a check its state.
function line(s: McpServer): string {
  const what =
    s.kind === "connector" ? "From your claude.ai login" : s.kind === "http" ? `At ${s.target}` : `Runs ${s.target || "(no command)"}`;
  const parts = [
    what + (s.headers ? ", with headers" : ""),
    s.desk && "this desk's own, connected in Settings → Agent",
    s.used_by.length > 0 && `used by ${s.used_by.join(", ")}`,
  ];
  const failed = s.status?.state === "failed" && s.status.detail;
  const signIn =
    s.status?.state === "needs-auth" && (s.kind === "connector" ? "connect it at claude.ai" : "sign in: run `claude`, then /mcp");
  return `${[...parts, failed, signIn].filter(Boolean).join("; ")}.`;
}

export function McpServers({ active, refresh, flash }: { active: boolean; refresh: number; flash: (text: string) => void }) {
  const [view, setView] = useState<McpView | null>(null);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [header, setHeader] = useState("");

  useKeyed(active ? refresh : null, (signal) => {
    runUi(
      api.mcp().pipe(
        Effect.match({
          onSuccess: (v) => {
            // A check's states and connectors stay until the next check.
            setView((was) => (was?.checked ? { ...v, servers: merged(v, was), checked: true } : v));
            setError("");
          },
          onFailure: (e) => {
            setError(e.message);
          },
        }),
      ),
      { signal },
    );
  });

  function check() {
    setChecking(true);
    setError("");
    runUi(
      api.checkMcp().pipe(
        Effect.match({
          onSuccess: setView,
          onFailure: (e) => {
            setError(e.message);
          },
        }),
        Effect.ensuring(
          Effect.sync(() => {
            setChecking(false);
          }),
        ),
      ),
    );
  }

  function add(e: SubmitEvent<HTMLFormElement>) {
    e.preventDefault();
    const t = target.trim();
    const remote = /^https?:\/\//.test(t);
    setBusy(true);
    setError("");
    runUi(
      api
        .addMcp({
          name: name.trim(),
          ...(remote ? { url: t } : { command: t.split(/\s+/).filter(Boolean) }),
          ...(header.trim() && { header: header.trim() }),
        })
        .pipe(
          Effect.match({
            onSuccess: (v) => {
              setView(v);
              flash(`Added ${name.trim()}`);
              setName("");
              setTarget("");
              setHeader("");
            },
            onFailure: (x) => {
              setError(x.message);
            },
          }),
          Effect.ensuring(
            Effect.sync(() => {
              setBusy(false);
            }),
          ),
        ),
    );
  }

  function remove(n: string) {
    setError("");
    runUi(
      api.removeMcp(n).pipe(
        Effect.match({
          onSuccess: (v) => {
            setView(v);
            flash(`Removed ${n}`);
          },
          onFailure: (x) => {
            setError(x.message);
          },
        }),
      ),
    );
  }

  if (!view)
    return (
      <div className="lines s-sheet">
        {error ? (
          <div className="setting s-status">
            <p className="s-help t-bad">{error}</p>
          </div>
        ) : (
          <div className="setting" aria-hidden="true">
            <SkLines count={2} />
          </div>
        )}
      </div>
    );
  const claude = view.agent === "Claude Code";
  return (
    <>
      <div className="lines s-sheet">
        <div className="setting s-status">
          <div className="s-label-col">
            <p className="s-label">Your {view.agent}'s servers</p>
            <p className="s-help">
              Kept in <code>{view.config}</code>. An automation that names one reads through it, with no other of yours.
            </p>
          </div>
          {claude && (
            <div className="s-control">
              <button type="button" className="act" disabled={checking} onClick={check}>
                {checking ? "Checking…" : "Check connections"}
              </button>
            </div>
          )}
        </div>
        {view.servers.length === 0 && (
          <div className="setting s-status">
            <p className="s-help">None yet. Add one below.</p>
          </div>
        )}
        {view.servers.map((s) => (
          <div key={s.name} className="setting s-status">
            <div className="s-label-col">
              <p className="s-label">
                {s.name}
                {s.status && <span className={cls("mcp-state", `mcp-${s.status.state}`)}>{STATE[s.status.state]}</span>}
              </p>
              <p className={cls("s-help", s.status?.state === "failed" && "t-bad")}>{withCode(line(s))}</p>
            </div>
            {s.kind !== "connector" && !s.desk && (
              <div className="s-control">
                <button
                  type="button"
                  className="act"
                  onClick={() => {
                    remove(s.name);
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ))}
        {error && (
          <div className="setting s-status">
            <p className="s-help t-bad">{withCode(error)}</p>
          </div>
        )}
      </div>
      <h2 className="group-head">Add a server</h2>
      <form className="lines s-sheet mcp-add" onSubmit={add}>
        <label className="au-field">
          <span className="s-label">Name</span>
          <input
            className="input"
            value={name}
            placeholder="gmail"
            onChange={(e) => {
              setName(e.target.value);
            }}
          />
        </label>
        <label className="au-field">
          <span className="s-label">URL or command</span>
          <input
            className="input"
            value={target}
            placeholder="https://mcp.example.com/mcp, or npx -y some-mcp-server"
            onChange={(e) => {
              setTarget(e.target.value);
            }}
          />
        </label>
        {/^https?:\/\//.test(target.trim()) && view.agent !== "Codex" && (
          <label className="au-field">
            <span className="s-label">Header</span>
            <input
              className="input"
              value={header}
              placeholder="Authorization: Bearer …"
              onChange={(e) => {
                setHeader(e.target.value);
              }}
            />
            <span className="s-help">Only if the server takes a key. Most sign in instead: check connections after adding.</span>
          </label>
        )}
        <div className="actions">
          <button type="submit" className="act primary" disabled={busy || !name.trim() || !target.trim()}>
            {busy ? "Adding…" : "Add"}
          </button>
        </div>
        <p className="s-help">
          Added for every project, as{" "}
          <code>{claude ? "claude mcp add --scope user" : view.agent === "Codex" ? "codex mcp add" : "opencode mcp add"}</code> would.
        </p>
      </form>
    </>
  );
}

// A reload keeps the last check's states and the connectors only a check sees.
function merged(v: McpView, was: McpView): McpServer[] {
  const servers = v.servers.map((s) => {
    const old = was.servers.find((x) => x.name === s.name);
    return old?.status ? { ...s, status: old.status } : s;
  });
  return [...servers, ...was.servers.filter((x) => x.kind === "connector" && !servers.some((s) => s.name === x.name))];
}
