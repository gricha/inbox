// A write client that refuses everything: a test's fake writer spreads it and overrides the writes it plays.
import { Effect } from "effect";
import { GitHubGraphQLError } from "../../src/errors.ts";
import type { GitHubWriter } from "../../src/github/write.ts";

export function refuseWrites(why = "not in this test"): GitHubWriter {
  const no = () => Effect.fail(new GitHubGraphQLError({ message: why }));
  return {
    approve: no,
    reply: no,
    comment: no,
    inlineComment: no,
    ready: no,
    requestReviews: no,
    rerequest: no,
    close: no,
    draft: no,
    merge: no,
    reopen: no,
    requestChanges: no,
    closeIssue: no,
    unrequest: no,
  };
}
