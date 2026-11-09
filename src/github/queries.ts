// GraphQL documents. Queries only; every one reports rateLimit so the client can track budget.

const RATE = "rateLimit { remaining resetAt cost }";
const HIT = "id number title updatedAt repository { nameWithOwner } author { __typename login }";

export const VIEWER = `query { ${RATE} viewer { login } }`;

export const LIGHT_SEARCH = `query($q: String!, $first: Int!, $after: String) {
  ${RATE}
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest { ${HIT} }
      ... on Issue { ${HIT} }
    }
  }
}`;

// Where you work: each PR's changed paths. 50 a page: 100 took 9.5 s of GitHub's 10 s limit, 50 up to 7 s (2026-11-02).
export const FILES_SEARCH = `query($q: String!, $first: Int!, $after: String) {
  ${RATE}
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { id repository { nameWithOwner } changedFiles files(first: 50) { nodes { path } } } }
  }
}`;

const COMMON = `
  id number title url state createdAt updatedAt closedAt bodyText
  author { __typename login }
  repository { nameWithOwner }
  labels(first: 15) { nodes { name } }
  assignees(first: 10) { nodes { login } }
  comments(last: 10) { totalCount nodes { author { __typename login } authorAssociation createdAt } }`;

const REVIEW = "author { __typename login } authorAssociation state submittedAt createdAt commit { oid }";
const REVIEWER = "__typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login }";

const PR = `${COMMON}
  isDraft body additions deletions changedFiles baseRefName baseRepository { defaultBranchRef { name } } headRefName headRepository { nameWithOwner }
  reviewDecision mergedBy { login }
  files(first: 50) { nodes { path } }
  reviewRequests(first: 30) { nodes { asCodeOwner requestedReviewer { ${REVIEWER} } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
    nodes { ... on ReviewRequestedEvent { createdAt actor { __typename login } requestedReviewer { ${REVIEWER} } } }
  }
  baseChanges: timelineItems(itemTypes: [BASE_REF_CHANGED_EVENT, AUTOMATIC_BASE_CHANGE_SUCCEEDED_EVENT], last: 1) {
    nodes {
      ... on BaseRefChangedEvent { previousRefName createdAt }
      ... on AutomaticBaseChangeSucceededEvent { oldBase createdAt }
    }
  }
  readied: timelineItems(itemTypes: [READY_FOR_REVIEW_EVENT], last: 1) { nodes { ... on ReadyForReviewEvent { createdAt } } }
  latestReviews(first: 20) { nodes { ${REVIEW} } }
  latestOpinionatedReviews(first: 20) { nodes { ${REVIEW} } }
  reviews(last: 20) { nodes { ${REVIEW} } }
  commits(last: 1) { nodes { commit { oid committedDate author { user { login } } statusCheckRollup { state } } } }`;

const details = (pr: string) => `query($ids: [ID!]!) {
  ${RATE}
  nodes(ids: $ids) {
    __typename
    ... on PullRequest { ${pr} }
    ... on Issue { ${COMMON} }
  }
}`;

// mergeable and per-thread comments are the slow parts, so only your own PRs get them.
export const DETAILS_REVIEW = details(`${PR}
  reviewThreads(first: 60) { totalCount nodes { isResolved } }`);

// isRequired needs the PR's own id, so each of your PRs is its own aliased node (n0, n1, …) with its id as $id0, $id1, ….
const check = (id: string) =>
  `__typename ... on CheckRun { name status conclusion isRequired(pullRequestId: ${id}) } ... on StatusContext { context state isRequired(pullRequestId: ${id}) }`;

// Failing check names are for Merging and your cards, so they're only asked of your own PRs too, as are the merge method and
// the latest commits (whose push outdated a thread).
export function detailsMine(n: number): string {
  const one = (i: number) => `n${i}: node(id: $id${i}) {
    __typename
    ... on PullRequest { ${PR}
      mergeable
      repository { viewerDefaultMergeMethod }
      reviewThreads(first: 60) { totalCount nodes { isResolved isOutdated comments(last: 1) { nodes { author { __typename login } authorAssociation createdAt commit { oid } } } } }
      recent: commits(last: 20) { nodes { commit { oid committedDate author { user { login } } } } }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 60) { nodes { ${check(`$id${i}`)} } } } } } }
    }
  }`;
  const ids = Array.from({ length: n }, (_, i) => i);
  return `query(${ids.map((i) => `$id${i}: ID!`).join(", ")}) {
  ${RATE}
  ${ids.map(one).join("\n  ")}
}`;
}

// Stack probes in one repo, one alias each: up, the PRs whose head is the branch, any state (a fork's are dropped after);
// down, the open PRs based on it; pr, the PR of that number, which a PR on the desk needs merged first. Exact branch
// names, unlike search's head:/base: qualifiers.
const PROBE = {
  up: (i: number) =>
    `p${i}: pullRequests(headRefName: $b${i}, states: [OPEN, MERGED, CLOSED], first: 3, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...B } }`,
  down: (i: number) =>
    `p${i}: pullRequests(baseRefName: $b${i}, states: [OPEN], first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...B } }`,
  pr: (i: number) => `p${i}: issueOrPullRequest(number: $b${i}) { ... on PullRequest { ...B } }`,
};

export function branchPrs(dirs: (keyof typeof PROBE)[]): string {
  return `query($owner: String!, $name: String!, ${dirs.map((d, i) => `$b${i}: ${d === "pr" ? "Int" : "String"}!`).join(", ")}) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    ${dirs.map((d, i) => PROBE[d](i)).join("\n    ")}
  }
}
fragment B on PullRequest { __typename ${HIT} headRepository { nameWithOwner } }`;
}

// desk_add's way in for a PR or issue no search returned: the details query wants its node id.
export const LOOKUP = `query($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on PullRequest { ${HIT} }
      ... on Issue { ${HIT} }
    }
  }
}`;

// A PR's conversation: its review threads (with ids to reply to), reviews, comments and recent commits.
export const PR_CONTEXT = `query($id: ID!) {
  ${RATE}
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line diffSide
          hunk: comments(first: 1) { nodes { diffHunk } }
          comments(first: 30) { nodes { id author { __typename login } body createdAt url commit { oid } } }
        }
      }
      reviews(last: 30) { nodes { id author { __typename login } state body submittedAt createdAt url } }
      comments(last: 20) { nodes { id author { __typename login } body createdAt url } }
      history: commits(last: 20) { nodes { commit { oid messageHeadline committedDate author { user { login } } } } }
    }
  }
}`;

// A PR's checks one by one, for its review: each check run and commit status on its head commit, whether the base branch
// requires it, and its page. 100 a page.
export const PR_CHECKS = `query($id: ID!, $after: String) {
  ${RATE}
  node(id: $id) {
    ... on PullRequest {
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          __typename
          ... on CheckRun { name status conclusion permalink isRequired(pullRequestId: $id) }
          ... on StatusContext { context state targetUrl isRequired(pullRequestId: $id) }
        }
      } } } } }
    }
  }
}`;

// Who you can ask to review your PR: GitHub's suggestions, then people and the owner org's teams matching what you typed.
// A user's repo has no org: that part comes back null.
export const REVIEWERS = `query($owner: String!, $name: String!, $number: Int!, $q: String) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { suggestedReviewers { reviewer { id login name } } }
    assignableUsers(first: 20, query: $q) { nodes { id login name } }
  }
  organization(login: $owner) { teams(first: 10, query: $q) { nodes { id slug name } } }
}`;

export const TEAMS = `query($me: String!) {
  ${RATE}
  viewer { name organizations(first: 50) { nodes { login teams(first: 100, userLogins: [$me]) { nodes { slug } } } } }
}`;
