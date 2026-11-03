// The desk's only writes to GitHub: the mutations on ALLOWED, sent when you act in the UI, each one logged.
// It doesn't go through the read client (client.ts), which keeps refusing every mutation.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GH_MISSING } from "./client.ts";

const ENDPOINT = "https://api.github.com/graphql";
// oxlint-disable-next-line typescript/strict-void-return -- promisify picks execFile's util.promisify.custom form, so no return value is discarded
const execFileAsync = promisify(execFile);

// Every mutation the desk may send. No MCP tool or CLI command reaches this module: agents never approve or post.
// commitOID pins the approval to the commit you read, not whatever was pushed since.
// reply and comment: your reply to a conversation in a PR's review, when you press Send.
// ready: your own draft's "Ready for review" (a a on its row).
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
  ready: `mutation DeskReady($pr: ID!) {
  markPullRequestReadyForReview(input: { pullRequestId: $pr }) { pullRequest { isDraft } }
}`,
} as const;

export interface GitHubWriter {
  approve(prNodeId: string, commit: string, body?: string): Promise<{ url: string }>;
  reply(threadId: string, body: string): Promise<{ url: string }>; // to a review thread
  comment(prNodeId: string, body: string): Promise<{ url: string }>; // on the PR
  ready(prNodeId: string): Promise<void>; // a draft, ready for review
}

export function createWriter(opts: { token?: string; fetch?: typeof fetch; log?: (msg: string) => void } = {}): GitHubWriter {
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? (() => {});

  // Read fresh for every write rather than shared with the read client.
  async function token(): Promise<string> {
    if (opts.token) return opts.token;
    if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
    try {
      return (await execFileAsync("gh", ["auth", "token"])).stdout.trim();
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(err.code === "ENOENT" ? GH_MISSING : `no GitHub token: set GITHUB_TOKEN or run \`gh auth login\` (${err.message})`, {
        cause: e,
      });
    }
  }

  // No retries: a write that timed out may have landed.
  async function send(name: keyof typeof ALLOWED, target: string, variables: Record<string, unknown>): Promise<unknown> {
    log(`github write: ${name} ${target}${typeof variables.commit === "string" ? ` at ${variables.commit}` : ""}`);
    const res = await doFetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `bearer ${await token()}`, "content-type": "application/json", "user-agent": "review-desk" },
      body: JSON.stringify({ query: ALLOWED[name], variables }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`GitHub HTTP ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { data?: unknown; errors?: { message: string }[] };
    if (json.errors?.length) throw new Error(`GitHub: ${json.errors.map((e) => e.message).join("; ")}`);
    return json.data;
  }

  return {
    approve: async (pr, commit, body) => {
      const data = (await send("approve", pr, { pr, commit, body: body ?? null })) as {
        addPullRequestReview?: { pullRequestReview?: { url?: string } | null } | null;
      } | null;
      return { url: data?.addPullRequestReview?.pullRequestReview?.url ?? "" };
    },
    reply: async (thread, body) => {
      const data = (await send("reply", thread, { thread, body })) as {
        addPullRequestReviewThreadReply?: { comment?: { url?: string } | null } | null;
      } | null;
      return { url: data?.addPullRequestReviewThreadReply?.comment?.url ?? "" };
    },
    comment: async (subject, body) => {
      const data = (await send("comment", subject, { subject, body })) as {
        addComment?: { commentEdge?: { node?: { url?: string } | null } | null } | null;
      } | null;
      return { url: data?.addComment?.commentEdge?.node?.url ?? "" };
    },
    ready: async (pr) => {
      await send("ready", pr, { pr });
    },
  };
}
