// acme/web#2303: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/export/api.ts",
      "modified",
      `@@ -3,9 +3,11 @@ import { http } from "../http.ts";
 export type ExportFormat = "csv" | "xlsx";

 export interface ExportJob {
   id: string;
-  state: "running" | "done" | "failed";
+  state: "running" | "done" | "failed" | "cancelled";
+  done: number; // rows written so far
+  total: number | null; // null until the server has counted the rows
   url?: string;
 }

 export function startExport(reportId: string, format: ExportFormat): Promise<ExportJob> {
@@ -15,3 +17,7 @@ export function startExport(reportId: string, format: ExportFormat): Promise<ExportJob> {
 export function getExport(id: string): Promise<ExportJob> {
   return http.get(\`/api/exports/\${id}\`);
 }
+
+export function cancelExport(id: string): Promise<void> {
+  return http.delete(\`/api/exports/\${id}\`);
+}`,
    ),
    file(
      "src/export/exportStore.ts",
      "added",
      `@@ -0,0 +1,51 @@
+import { useSyncExternalStore } from "react";
+import { cancelExport, getExport, startExport, type ExportFormat, type ExportJob } from "./api.ts";
+
+const POLL_MS = 1000;
+
+// The one export this tab is running, shared by the toolbar and the dialog, so closing the dialog doesn't lose it.
+let job: ExportJob | null = null;
+let timer: ReturnType<typeof setInterval> | undefined;
+const listeners = new Set<() => void>();
+
+function set(next: ExportJob | null) {
+  job = next;
+  for (const l of listeners) l();
+  if (job?.state !== "running") {
+    clearInterval(timer);
+    timer = undefined;
+  } else if (!timer) {
+    timer = setInterval(poll, POLL_MS);
+  }
+}
+
+async function poll() {
+  if (!job) return;
+  const { id } = job;
+  const next = await getExport(id);
+  // A cancel or a new export may have replaced it while the request was out.
+  if (job?.id === id && job.state === "running") set(next);
+}
+
+export async function start(reportId: string, format: ExportFormat): Promise<void> {
+  if (job?.state === "running") return;
+  set(await startExport(reportId, format));
+}
+
+export async function cancel(): Promise<void> {
+  if (job?.state !== "running") return;
+  const { id } = job;
+  await cancelExport(id);
+  if (job?.id === id) set({ ...job, state: "cancelled" });
+}
+
+function subscribe(listener: () => void) {
+  listeners.add(listener);
+  return () => {
+    listeners.delete(listener);
+  };
+}
+
+export function useExportJob(): ExportJob | null {
+  return useSyncExternalStore(subscribe, () => job);
+}`,
    ),
    file(
      "src/toolbar/ExportButton.tsx",
      "modified",
      `@@ -1,10 +1,26 @@
+import { cancel, useExportJob } from "../export/exportStore.ts";
 import { Button } from "../ui/Button.tsx";
-import { DownloadIcon } from "../ui/icons.tsx";
+import { DownloadIcon, StopIcon } from "../ui/icons.tsx";
+import { ProgressRing } from "../ui/ProgressRing.tsx";

 export function ExportButton({ onOpen }: { onOpen: () => void }) {
+  const job = useExportJob();
+  if (job?.state !== "running") {
+    return (
+      <Button variant="ghost" onClick={onOpen} title="Export">
+        <DownloadIcon />
+      </Button>
+    );
+  }
+  // Until the server has counted the rows there's no share to show, so the ring spins.
+  const share = job.total ? job.done / job.total : null;
+  const label = share === null ? "Exporting…" : \`Exporting: \${Math.round(share * 100)}%\`;
   return (
-    <Button variant="ghost" onClick={onOpen} title="Export">
-      <DownloadIcon />
-    </Button>
+    <span className="export-progress" role="status" aria-label={label} title={label}>
+      <ProgressRing value={share} size={16} onClick={onOpen} />
+      <Button variant="ghost" onClick={() => void cancel()} title="Cancel the export">
+        <StopIcon />
+      </Button>
+    </span>
   );
 }`,
    ),
    file(
      "src/export/ExportDialog.tsx",
      "modified",
      `@@ -1,17 +1,12 @@
-import { useEffect, useState } from "react";
-import { getExport, startExport, type ExportFormat, type ExportJob } from "./api.ts";
+import { useState } from "react";
+import type { ExportFormat } from "./api.ts";
+import { cancel, start, useExportJob } from "./exportStore.ts";
 import { Button } from "../ui/Button.tsx";
 import { Dialog } from "../ui/Dialog.tsx";

 export function ExportDialog({ reportId, onClose }: { reportId: string; onClose: () => void }) {
   const [format, setFormat] = useState<ExportFormat>("csv");
-  const [job, setJob] = useState<ExportJob | null>(null);
-
-  useEffect(() => {
-    if (job?.state !== "running") return;
-    const timer = setInterval(async () => setJob(await getExport(job.id)), 1000);
-    return () => clearInterval(timer);
-  }, [job]);
+  const job = useExportJob();

   return (
     <Dialog title="Export" onClose={onClose}>
@@ -28,11 +24,17 @@ export function ExportDialog({ reportId, onClose }: { reportId: string; onClose: () => void }) {
         </select>
       </label>
-      {job?.state === "running" && <p>Exporting…</p>}
+      {job?.state === "running" && (
+        <p>
+          Exporting{job.total ? \`: \${job.done.toLocaleString()} of \${job.total.toLocaleString()} rows\` : "…"}
+        </p>
+      )}
       {job?.state === "done" && <a href={job.url}>Download</a>}
       {job?.state === "failed" && <p className="error">The export failed. Try again.</p>}
       <footer>
-        <Button onClick={async () => setJob(await startExport(reportId, format))} disabled={job?.state === "running"}>
-          Export
-        </Button>
+        {job?.state === "running" ? (
+          <Button onClick={() => void cancel()}>Cancel export</Button>
+        ) : (
+          <Button onClick={() => void start(reportId, format)}>Export</Button>
+        )}
       </footer>
     </Dialog>`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Moves the running export out of the dialog's own state into a small store (`exportStore.ts`) that the toolbar and the dialog both read, so the toolbar's export button can show a progress ring and a Cancel button while an export runs. The API gains rows-written counts and a `cancelExport` call.",
    concerns: [
      '`start()` only knows an export is running once `startExport` has answered, so a second click on Export while that request is out passes the `job?.state === "running"` check and starts a second export, the case the PR sets out to stop. Mark the store as starting before the `await` (or disable the button while it\'s pending).',
    ],
    notes: [
      {
        path: "src/export/exportStore.ts",
        side: "new",
        line: 7,
        body: "The running export lives in module memory for this tab: closing the dialog no longer loses it, but a reload still does, and the toolbar shows nothing for an export that keeps running on the server.",
      },
      {
        path: "src/export/exportStore.ts",
        side: "new",
        line: 27,
        body: "Drops a poll that comes back after a cancel or a new export, so a late answer can't put a cancelled export back on the toolbar.",
      },
      {
        path: "src/export/exportStore.ts",
        side: "new",
        line: 31,
        body: "The guard the concern is about: `job` is still the previous export (or null) until `startExport` resolves.",
      },
      {
        path: "src/toolbar/ExportButton.tsx",
        side: "new",
        line: 16,
        body: "`total` is null until the server has counted the rows, so the ring spins instead of showing NaN%.",
      },
      {
        path: "src/export/ExportDialog.tsx",
        side: "old",
        line: 10,
        body: "Why closing the dialog used to lose the export: its polling lived here and stopped when the dialog unmounted.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h3", path: "src/export/exportStore.ts", level: "look", why: "start() guard misses an export in flight" },
        { id: "h4", path: "src/toolbar/ExportButton.tsx", level: "skim", why: "progress ring and Cancel" },
        { id: "h6", path: "src/export/ExportDialog.tsx", level: "skim", why: "Export and Cancel swap places" },
        { id: "h5", path: "src/export/ExportDialog.tsx", level: "skim", why: "local polling removed" },
        { id: "h1", path: "src/export/api.ts", level: "skim", why: "rows counted, cancelled state" },
      ],
      unread: [],
      total: 6,
    },
    guide: {
      steps: [
        {
          title: "One export per tab",
          body: "The export's state moves from the dialog into `exportStore.ts`, which polls while it runs and tells every reader when it changes. The API adds the row counts it polls for and a cancel call.",
          check: "Two quick clicks on Export start one export, not two.",
          hunks: [
            { id: "h3", path: "src/export/exportStore.ts" },
            { id: "h1", path: "src/export/api.ts" },
            { id: "h2", path: "src/export/api.ts" },
          ],
        },
        {
          title: "The toolbar's button",
          body: "While an export runs, the toolbar shows a progress ring that opens the dialog and a Cancel button; otherwise it's the export button it was.",
          check: "The ring spins rather than showing a share while `total` is null.",
          hunks: [{ id: "h4", path: "src/toolbar/ExportButton.tsx" }],
        },
        {
          title: "The dialog",
          body: "The dialog reads the same store instead of its own state, shows rows written, and swaps Export for Cancel export while one runs.",
          check: "",
          hunks: [
            { id: "h5", path: "src/export/ExportDialog.tsx" },
            { id: "h6", path: "src/export/ExportDialog.tsx" },
          ],
        },
      ],
    },
  },
};
