TL = '''timelineItems(first:%d, itemTypes:[REVIEW_REQUESTED_EVENT, REVIEW_REQUEST_REMOVED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT]){
  totalCount
  nodes{ __typename
    ... on ReviewRequestedEvent{ createdAt actor{login} requestedReviewer{ __typename ... on User{login} ... on Team{slug} ... on Bot{login} } }
    ... on ReviewRequestRemovedEvent{ createdAt actor{login} requestedReviewer{ __typename ... on User{login} ... on Team{slug} ... on Bot{login} } }
    ... on ReadyForReviewEvent{ createdAt }
    ... on ConvertToDraftEvent{ createdAt }
  } }'''

META = '''id number title createdAt closedAt mergedAt state isDraft additions deletions changedFiles
repository{ nameWithOwner } author{ __typename login }'''

LIGHT = '... on PullRequest { %s %s }' % (META, TL % 40)

FILES = 'files(first:100){ totalCount nodes{ path } }'
REVIEWS = 'reviews(first:40){ totalCount nodes{ author{login} state submittedAt } }'

FULL = '... on PullRequest { %s %s %s %s body }' % (META, TL % 40, FILES, REVIEWS)

ENGAGED = '''... on PullRequest { %s %s %s %s
  myreviews: reviews(author:"gricha", first:30){ totalCount nodes{ state submittedAt createdAt } }
  comments(first:100){ totalCount nodes{ author{login} createdAt } }
  reviewRequests(first:20){ nodes{ asCodeOwner requestedReviewer{ __typename ... on User{login} ... on Team{slug} } } }
  body
}''' % (META, TL % 60, FILES, REVIEWS)

DETAIL = '%s %s %s body' % (META, FILES, REVIEWS)  # for nodes(ids:) pass 2 (timeline already known)

MINE = '... on PullRequest { %s %s }' % (META, FILES)
