// A connector turns one source (GitHub today) into item snapshots and events. The desk runs every connector it has.
import type { ActivityEvent, ConnectorStatus, Item } from "../types.ts";

export type NewEvent = Omit<ActivityEvent, "seq" | "source">;

export interface Connector {
  readonly id: string; // "github"; the `source` of its events
  readonly name: string; // "GitHub"
  start(): void; // its loops: the full reconcile and the cheap change feed
  stop(): void;
  reschedule(): void; // settings changed; re-arm the timers
  reconcile(): Promise<void>; // a full pass over everything the config subscribes to
  poll(): Promise<void>; // the change feed: refresh what changed, start a reconcile if something new appeared
  events(prev: Item | null, next: Item): NewEvent[]; // what changed between two snapshots of one item
  status(): ConnectorStatus;
}
