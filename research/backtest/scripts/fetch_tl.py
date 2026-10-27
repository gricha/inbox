"""Re-fetch timelines (first:100) for PRs whose first-40 timeline page was truncated."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from gql import nodes_by_id, DATA
from frags import TL
path = os.path.join(DATA, 'tl_extra.json')
X = json.load(open(path)) if os.path.exists(path) else {}
ids = []
for name in sys.argv[1:]:
    P = json.load(open(os.path.join(DATA, f'pop_{name}.json'))); P.pop('_slices', None)
    for k, n in P.items():
        if n['timelineItems']['totalCount'] > 40 and k not in X and (n['author'] or {}).get('login') != 'gricha':
            ids.append(n['id'])
print('refetch', len(ids), flush=True)
frag = 'number repository{nameWithOwner} isDraft ' + (TL % 100)
for n in nodes_by_id(ids, frag, batch=50, tag='tlx'):
    X[f"{n['repository']['nameWithOwner']}#{n['number']}"] = n['timelineItems']
json.dump(X, open(path, 'w'))
print('tl_extra', len(X))
