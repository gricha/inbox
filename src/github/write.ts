// The desk's only writes to GitHub: the mutations on ALLOWED, sent when you act in the UI, each one logged.
// It doesn't go through the read client (client.ts), which keeps refusing every mutation.
import { Effect } from "effect";
import { GitHubGraphQLError, GitHubHttpError, GitHubWriteUncertain, type GitHubWriteError } from "../errors.ts";
import { decode, readToken } from "./client.ts";

const ENDPOINT = "https://api.github.com/graphql";

// Every mutation the desk may send. No MCP tool or CLI command reaches this module: agents never approve or post.
// commitOID pins the approval to the commit you read, not whatever was pushed since.
// reply and comment: your reply to a conversation in a PR's review, when you press Send.
// inline_comment: your comment on a line (or lines) of a PR's diff, posted at once like GitHub's "Add single comment", pinned
// to the commit the review showed.
// ready: your own draft's "Ready for review" (on its row or in its review); request_reviews: the reviewers you picked with
// it, added to any already asked (union).
// The rest are the More menu's: close, draft, mark ready, merge and reopen your own PR, re-request review from who reviewed it,
// request changes on someone else's, close an issue.
// expectedHeadOid pins a merge to the commit the desk judged ready, so a push since then isn't merged unseen.
export const ALLOWED = {
  approve: `mutation DeskApprove($pr: ID!, $commit: GitObjectID!, $body: String) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: APPROVE, body: $body }) { pullRequestReview { url } }
}`,
  reply: `mutation DeskReply($thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { url } }
}`,
  comment: `mutation DeskComment($subject: ID!, $body: String!) {
  addComment(input: { subjectId: $subject, body: $body }) { commentEdge { node { url } } }
}`,
  inline_comment: `mutation DeskInlineComment($pr: ID!, $commit: GitObjectID!, $thread: DraftPullRequestReviewThread!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: COMMENT, threads: [$thread] }) { pullRequestReview { url comments(first: 1) { nodes { url } } } }
}`,
  ready: `mutation DeskReady($pr: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pr }) { pullRequest { isDraft } }
}`,
  request_reviews: `mutation DeskRequestReviews($pr: ID!, $users: [ID!], $teams: [ID!]) {
  requestReviews(input: { pullRequestId: $pr, userIds: $users, teamIds: $teams, union: true }) { pullRequest { id } }
}`,
  rerequest: `mutation DeskRerequest($pr: ID!, $users: [String!]) {
  requestReviewsByLogin(input: { pullRequestId: $pr, userLogins: $users, union: true }) { pullRequest { id } }
}`,
  close: `mutation DeskClose($pr: ID!) {
  closePullRequest(input: { pullRequestId: $pr }) { pullRequest { state } }
}`,
  draft: `mutation DeskDraft($pr: ID!) {
  convertPullRequestToDraft(input: { pullRequestId: $pr }) { pullRequest { isDraft } }
}`,
  merge: `mutation DeskMerge($pr: ID!, $head: GitObjectID!, $method: PullRequestMergeMethod!) {
  mergePullRequest(input: { pullRequestId: $pr, expectedHeadOid: $head, mergeMethod: $method }) { pullRequest { state } }
}`,
  reopen: `mutation DeskReopen($pr: ID!) {
  reopenPullRequest(input: { pullRequestId: $pr }) { pullRequest { state } }
}`,
  request_changes: `mutation DeskRequestChanges($pr: ID!, $commit: GitObjectID!, $body: String!) {
  addPullRequestReview(input: { pullRequestId: $pr, commitOID: $commit, event: REQUEST_CHANGES, body: $body }) { pullRequestReview { url } }
}`,
  close_issue: `mutation DeskCloseIssue($issue: ID!) {
  closeIssue(input: { issueId: $issue }) { issue { state } }
}`,
} as const;

// The one REST write, for what GraphQL can't do: take your own review request off someone else's PR.
export const REST_ALLOWED = {
  unrequest: "DELETE /repos/{repo}/pulls/{number}/requested_reviewers",
} as const;

// GitHub's DraftPullRequestReviewThread: line numbers in the file on that side (LEFT: the old file), the range ending at line.
export interface InlineThread {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  startLine?: number;
  startSide?: "LEFT" | "RIGHT";
  body: string;
}

export interface GitHubWriter {
  approve(prNodeId: string, commit: string, body?: string): Effect.Effect<{ url: string }, GitHubWriteError>;
  reply(threadId: string, body: string): Effect.Effect<{ url: string }, GitHubWriteError>; // to a review thread
  comment(prNodeId: string, body: string): Effect.Effect<{ url: string }, GitHubWriteError>; // on the PR
  inlineComment(prNodeId: string, commit: string, thread: InlineThread): Effect.Effect<{ url: string }, GitHubWriteError>; // on a line of its diff
  ready(prNodeId: string): Effect.Effect<void, GitHubWriteError>; // a draft, ready for review
  requestReviews(prNodeId: string, users: string[], teams: string[]): Effect.Effect<void, GitHubWriteError>; // node ids
  rerequest(prNodeId: string, logins: string[]): Effect.Effect<void, GitHubWriteError>; // who reviewed it, asked again
  close(prNodeId: string): Effect.Effect<void, GitHubWriteError>;
  draft(prNodeId: string): Effect.Effect<void, GitHubWriteError>; // back to draft
  merge(prNodeId: string, head: string, method: "MERGE" | "SQUASH" | "REBASE"): Effect.Effect<void, GitHubWriteError>;
  reopen(prNodeId: string): Effect.Effect<void, GitHubWriteError>;
  requestChanges(prNodeId: string, commit: string, body: string): Effect.Effect<{ url: string }, GitHubWriteError>;
  closeIssue(issueNodeId: string): Effect.Effect<void, GitHubWriteError>;
  unrequest(repo: string, number: number, login: string): Effect.Effect<void, GitHubWriteError>; // you, off its reviewers
}

type Url = { url?: string } | null;

export function createWriter(opts: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void } = {}): GitHubWriter {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});

  // No retries: a write that timed out may have landed. No signal either: once sent, it runs to GitHub's answer or its timeout.
  const send = Effect.fnUntraced(function* (
    name: keyof typeof ALLOWED,
    target: string,
    variables: Record<string, unknown>,
  ): Effect.fn.Return<unknown, GitHubWriteError> {
    const at = variables.commit ?? variables.head;
    log(`github write: ${name} ${target}${typeof at === "string" ? ` at ${at}` : ""}`);
    // Read fresh for every write rather than shared with the read client.
    const authorization = `bearer ${yield* readToken(opts.token)}`;
    const { res, text } = yield* Effect.tryPromise({
      try: async () => {
        const answer = await doFetch(ENDPOINT, {
          method: "POST",
          headers: { authorization, "content-type": "application/json", "user-agent": "inbox" },
          body: JSON.stringify({ query: ALLOWED[name], variables }),
          signal: AbortSignal.timeout(30_000),
        });
        return { res: answer, text: await answer.text() };
      },
      catch: (cause) => new GitHubWriteUncertain({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    });
    if (!res.ok) return yield* new GitHubHttpError({ status: res.status, message: `GitHub HTTP ${res.status}: ${text.slice(0, 200)}` });
    // A 2xx whose body can't be read may have landed: uncertain, in the parser's words.
    const { data, errors } = yield* decode(() => {
      const json = JSON.parse(text) as { data?: unknown; errors?: { type?: string; message: string }[] };
      return { data: json.data, errors: (json.errors ?? []).map((e) => ({ type: e.type, message: e.message })) };
    }).pipe(Effect.mapError((e) => new GitHubWriteUncertain({ message: e.message, cause: e.cause })));
    const types = errors.flatMap((e) => (e.type ? [e.type] : []));
    if (errors.length)
      return yield* new GitHubGraphQLError({
        message: `GitHub: ${errors.map((e) => e.message).join("; ")}`,
        ...(types.length > 0 && { types }),
      });
    return data;
  });

  const sendRest = Effect.fnUntraced(function* (
    name: keyof typeof REST_ALLOWED,
    repo: string,
    number: number,
    body: Record<string, unknown>,
  ): Effect.fn.Return<void, GitHubWriteError> {
    log(`github write: ${name} ${repo}#${number}`);
    const authorization = `bearer ${yield* readToken(opts.token)}`;
    const [method = "", path = ""] = REST_ALLOWED[name].split(" ");
    const { res, text } = yield* Effect.tryPromise({
      try: async () => {
        const answer = await doFetch(`https://api.github.com${path.replace("{repo}", repo).replace("{number}", String(number))}`, {
          method,
          headers: { authorization, accept: "application/vnd.github+json", "content-type": "application/json", "user-agent": "inbox" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30_000),
        });
        return { res: answer, text: await answer.text() };
      },
      catch: (cause) => new GitHubWriteUncertain({ message: cause instanceof Error ? cause.message : String(cause), cause }),
    });
    if (!res.ok) return yield* new GitHubHttpError({ status: res.status, message: `GitHub HTTP ${res.status}: ${text.slice(0, 200)}` });
    return undefined;
  });

  const url = (u: Url | undefined) => ({ url: u?.url ?? "" });

  return {
    approve: (pr, commit, body) =>
      send("approve", pr, { pr, commit, body: body ?? null }).pipe(
        Effect.map((data) =>
          url((data as { addPullRequestReview?: { pullRequestReview?: Url } | null } | null)?.addPullRequestReview?.pullRequestReview),
        ),
      ),
    reply: (thread, body) =>
      send("reply", thread, { thread, body }).pipe(
        Effect.map((data) =>
          url((data as { addPullRequestReviewThreadReply?: { comment?: Url } | null } | null)?.addPullRequestReviewThreadReply?.comment),
        ),
      ),
    comment: (subject, body) =>
      send("comment", subject, { subject, body }).pipe(
        Effect.map((data) =>
          url((data as { addComment?: { commentEdge?: { node?: Url } | null } | null } | null)?.addComment?.commentEdge?.node),
        ),
      ),
    inlineComment: (pr, commit, thread) =>
      send("inline_comment", pr, { pr, commit, thread }).pipe(
        Effect.flatMap((data): Effect.Effect<{ url: string }, GitHubWriteUncertain> => {
          const review = (
            data as {
              addPullRequestReview?: {
                pullRequestReview?: { url?: string; comments?: { nodes?: { url?: string }[] } | null } | null;
              } | null;
            } | null
          )?.addPullRequestReview?.pullRequestReview;
          // GitHub has answered with no review and no error; better to keep your words than to say it landed.
          if (!review)
            return Effect.fail(
              new GitHubWriteUncertain({ message: "GitHub answered without the comment: check the PR before you send it again" }),
            );
          return Effect.succeed({ url: review.comments?.nodes?.[0]?.url ?? review.url ?? "" });
        }),
      ),
    ready: (pr) => send("ready", pr, { pr }).pipe(Effect.asVoid),
    requestReviews: (pr, users, teams) => send("request_reviews", pr, { pr, users, teams }).pipe(Effect.asVoid),
    rerequest: (pr, users) => send("rerequest", pr, { pr, users }).pipe(Effect.asVoid),
    close: (pr) => send("close", pr, { pr }).pipe(Effect.asVoid),
    draft: (pr) => send("draft", pr, { pr }).pipe(Effect.asVoid),
    merge: (pr, head, method) => send("merge", pr, { pr, head, method }).pipe(Effect.asVoid),
    reopen: (pr) => send("reopen", pr, { pr }).pipe(Effect.asVoid),
    requestChanges: (pr, commit, body) =>
      send("request_changes", pr, { pr, commit, body }).pipe(
        Effect.map((data) =>
          url((data as { addPullRequestReview?: { pullRequestReview?: Url } | null } | null)?.addPullRequestReview?.pullRequestReview),
        ),
      ),
    closeIssue: (issue) => send("close_issue", issue, { issue }).pipe(Effect.asVoid),
    unrequest: (repo, number, login) => sendRest("unrequest", repo, number, { reviewers: [login] }),
  };
}
