// A write client that refuses everything: a test's fake writer spreads it and overrides the writes it plays.
import type { GitHubWriter } from "../../src/github/write.ts";

export function refuseWrites(why = "not in this test"): GitHubWriter {
  const no = () => Promise.reject(new Error(why));
  return {
    approve: no,
    reply: no,
    comment: no,
    ready: no,
    close: no,
    draft: no,
    merge: no,
    reopen: no,
    requestChanges: no,
    closeIssue: no,
  };
}
