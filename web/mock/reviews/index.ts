// The demo's PRs (web/mock/desk.ts, MOCK_DEMO), one file each: a written diff and its AI review.
import type { Canned } from "../diffs.ts";
import { review as tinyhttp_212 } from "./tinyhttp-212.ts";
import { review as worker_870 } from "./worker-870.ts";
import { review as worker_875 } from "./worker-875.ts";
import { review as notes_app_12 } from "./notes-app-12.ts";
import { review as web_2303 } from "./web-2303.ts";
import { review as web_2295 } from "./web-2295.ts";
import { review as api_4122 } from "./api-4122.ts";
import { review as worker_871 } from "./worker-871.ts";
import { review as web_2288 } from "./web-2288.ts";
import { review as infra_540 } from "./infra-540.ts";

export const REVIEWS: Record<string, Canned | null> = {
  "oss/tinyhttp#212": tinyhttp_212,
  "acme/worker#870": worker_870,
  "acme/worker#875": worker_875,
  "me/notes-app#12": notes_app_12,
  "acme/web#2303": web_2303,
  "acme/web#2295": web_2295,
  "acme/api#4122": api_4122,
  "acme/worker#871": worker_871,
  "acme/web#2288": web_2288,
  "acme/infra#540": infra_540,
};
