// acme/web#2288: its diff and AI review for the website's demo.
import type { Canned } from "../diffs.ts";
import { file } from "../patch.ts";

export const review: Canned = {
  files: [
    file(
      "src/ui/EmptyState.tsx",
      "added",
      `@@ -0,0 +1,20 @@
+import type { ReactNode } from "react";
+
+interface Props {
+  icon: ReactNode;
+  title: string;
+  children?: ReactNode; // a sentence on why it's empty
+  action?: ReactNode;
+}
+
+// What a panel shows when it has nothing to show, so an empty one doesn't look broken.
+export function EmptyState({ icon, title, children, action }: Props) {
+  return (
+    <div className="empty-state" role="status">
+      <span className="empty-state-icon" aria-hidden="true">{icon}</span>
+      <h3>{title}</h3>
+      {children && <p>{children}</p>}
+      {action}
+    </div>
+  );
+}`,
    ),
    file(
      "src/dashboard/Dashboard.tsx",
      "modified",
      `@@ -12,6 +12,17 @@ export function Dashboard({ id }: { id: string }) {
   const { data: dashboard } = useDashboard(id);
   if (!dashboard) return <Spinner />;

+  if (dashboard.widgets.length === 0) {
+    return (
+      <EmptyState
+        icon={<LayoutIcon />}
+        title="This dashboard is empty"
+        action={<Button onClick={() => openWidgetPicker(id)}>Add a widget</Button>}
+      >
+        Widgets you add show up here.
+      </EmptyState>
+    );
+  }
   return (
     <Grid layout={dashboard.layout}>
       {dashboard.widgets.map((w) => (`,
    ),
    file(
      "src/dashboard/widgets/ChartWidget.tsx",
      "modified",
      `@@ -18,6 +18,12 @@ export function ChartWidget({ widget }: { widget: Widget }) {
   const { data, isLoading, error } = useSeries(widget.query, widget.range);
   if (isLoading) return <Skeleton height={widget.height} />;
   if (error) return <WidgetError error={error} />;
-  if (!data.series.length) return null;
+  if (!data.series.some((s) => s.points.length)) {
+    return (
+      <EmptyState icon={<ChartIcon />} title="No data in this range">
+        Try a longer range, or check the query matches any events.
+      </EmptyState>
+    );
+  }
   return <LineChart series={data.series} height={widget.height} />;
 }`,
    ),
    file(
      "src/dashboard/widgets/TableWidget.tsx",
      "modified",
      `@@ -15,7 +15,13 @@ export function TableWidget({ widget }: { widget: Widget }) {
   const { data, isLoading, error } = useRows(widget.query, widget.range);
   const rows = data?.rows ?? [];
+  if (!rows.length) {
+    return (
+      <EmptyState icon={<TableIcon />} title="No rows yet">
+        Rows appear here as soon as the query matches anything.
+      </EmptyState>
+    );
+  }
   if (isLoading) return <Skeleton height={widget.height} />;
   if (error) return <WidgetError error={error} />;
-  if (!rows.length) return <p className="muted">Nothing here.</p>;
   return <Table columns={widget.columns} rows={rows} />;
 }`,
    ),
  ],
  ai: {
    verdict: "skim",
    risk: "low",
    summary:
      "Adds an `EmptyState` component and uses it where the dashboard used to show nothing: a dashboard with no widgets offers Add a widget, a chart whose series have no points says so, and a table with no rows says so.",
    concerns: [
      'TableWidget now checks for empty rows before it checks `isLoading`, and `rows` is `[]` until the query answers, so every table shows "No rows yet" while it loads, and a failed query shows it instead of the error. The empty check belongs after the error check, where ChartWidget has it.',
    ],
    notes: [
      {
        path: "src/dashboard/widgets/ChartWidget.tsx",
        side: "new",
        line: 21,
        body: "A chart whose series all came back with no points used to draw empty axes; this treats it as empty too.",
      },
      {
        path: "src/dashboard/widgets/TableWidget.tsx",
        side: "new",
        line: 17,
        body: "The concern's line: it runs before the loading and error checks below.",
      },
    ],
    chunks: {
      ranked: [
        { id: "h4", path: "src/dashboard/widgets/TableWidget.tsx", level: "look", why: "empty check runs before loading" },
        { id: "h3", path: "src/dashboard/widgets/ChartWidget.tsx", level: "skim", why: "empty series shown as empty" },
        { id: "h2", path: "src/dashboard/Dashboard.tsx", level: "skim", why: "no widgets: Add a widget" },
        { id: "h1", path: "src/ui/EmptyState.tsx", level: "skim", why: "" },
      ],
      unread: [],
      total: 4,
    },
    guide: {
      steps: [
        {
          title: "The empty state",
          body: "One component, an icon, a title, a sentence and an optional action, used by the dashboard and both widgets.",
          check: "",
          hunks: [
            { id: "h1", path: "src/ui/EmptyState.tsx" },
            { id: "h2", path: "src/dashboard/Dashboard.tsx" },
          ],
        },
        {
          title: "The widgets",
          body: "Charts and tables show it when their query comes back empty, in place of nothing or a grey line.",
          check: "Loading and errors still win over empty, in both widgets.",
          hunks: [
            { id: "h3", path: "src/dashboard/widgets/ChartWidget.tsx" },
            { id: "h4", path: "src/dashboard/widgets/TableWidget.tsx" },
          ],
        },
      ],
    },
  },
};
