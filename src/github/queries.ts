// GraphQL documents. Queries only; every one reports rateLimit so the client can track budget.

const RATE = "rateLimit { remaining resetAt cost }";

export const VIEWER = `query { ${RATE} viewer { login } }`;

export const LIGHT_SEARCH = `query($q: String!, $first: Int!, $after: String) {
  ${RATE}
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on PullRequest { id number updatedAt repository { nameWithOwner } author { __typename login } }
      ... on Issue { id number updatedAt repository { nameWithOwner } author { __typename login } }
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

const REVIEWER = "__typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login }";

const PR = `${COMMON}
  isDraft additions deletions changedFiles baseRefName headRefName headRepository { nameWithOwner } reviewDecision mergedBy { login }
  files(first: 50) { nodes { path } }
  reviewRequests(first: 30) { nodes { asCodeOwner requestedReviewer { ${REVIEWER} } } }
  timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 20) {
    nodes { ... on ReviewRequestedEvent { createdAt actor { __typename login } requestedReviewer { ${REVIEWER} } } }
  }
  latestReviews(first: 20) { nodes { author { __typename login } authorAssociation state submittedAt createdAt commit { oid } } }
  latestOpinionatedReviews(first: 20) { nodes { author { __typename login } authorAssociation state submittedAt createdAt commit { oid } } }
  reviews(last: 20) { nodes { author { __typename login } authorAssociation state submittedAt createdAt commit { oid } } }
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

// Failing check names are for Merging and your cards, so they're only asked of your own PRs too, as is what auto-merge needs.
export function detailsMine(n: number): string {
  const one = (i: number) => `n${i}: node(id: $id${i}) {
    __typename
    ... on PullRequest { ${PR}
      mergeable
      autoMergeRequest { enabledAt }
      repository { autoMergeAllowed viewerDefaultMergeMethod }
      reviewThreads(first: 60) { totalCount nodes { isResolved comments(last: 1) { nodes { author { __typename login } authorAssociation createdAt } } } }
      checks: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 60) { nodes { ${check(`$id${i}`)} } } } } } }
    }
  }`;
  const ids = Array.from({ length: n }, (_, i) => i);
  return `query(${ids.map((i) => `$id${i}: ID!`).join(", ")}) {
  ${RATE}
  ${ids.map(one).join("\n  ")}
}`;
}

// authorAssociation (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...) says whose feedback a babysitter may act on.
// What a babysitter needs to work on your PR: its review threads (with ids to reply to), reviews, comments and failing checks.
export const PR_CONTEXT = `query($id: ID!) {
  ${RATE}
  node(id: $id) {
    ... on PullRequest {
      reviewThreads(first: 100) {
        nodes { id isResolved isOutdated path line comments(first: 30) { nodes { author { __typename login } authorAssociation body createdAt url } } }
      }
      reviews(last: 30) { nodes { author { __typename login } authorAssociation state body submittedAt createdAt } }
      comments(last: 20) { nodes { author { __typename login } authorAssociation body createdAt } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name conclusion databaseId detailsUrl title summary checkSuite { app { slug } } }
        ... on StatusContext { context state description targetUrl }
      } } } } } }
    }
  }
}`;

export const TEAMS = `query($me: String!) {
  ${RATE}
  viewer { organizations(first: 50) { nodes { login teams(first: 100, userLogins: [$me]) { nodes { slug } } } } }
}`;
