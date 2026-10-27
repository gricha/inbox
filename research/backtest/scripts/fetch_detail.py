"""Pass 2: files/reviews/body for light-scanned PRs that requested ML team or gricha (and aren't already in engaged.json)."""
import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from gql import nodes_by_id, DATA
from frags import DETAIL
from engaged_lib import requests
E = json.load(open(os.path.join(DATA, 'engaged.json')))
XTL = json.load(open(os.path.join(DATA, 'tl_extra.json'))) if os.path.exists(os.path.join(DATA, 'tl_extra.json')) else {}
path = os.path.join(DATA, 'detail.json')
D = json.load(open(path)) if os.path.exists(path) else {}
for name in sys.argv[1:]:
    P = json.load(open(os.path.join(DATA, f'pop_{name}.json'))); P.pop('_slices', None)
    for _k, _n in P.items():
        if _k in XTL: _n['timelineItems'] = XTL[_k]
    want = []
    for k, n in P.items():
        if k in E or k in D or (n['author'] or {}).get('login') == 'gricha':
            continue
        rq = requests(n)
        if any((r['kind'] == 'team' and r['target'] in ('machine-learning-ai', 'agent-platform', 'agent-platform-seer', 'agent-platform-sentry-backend')) or (r['kind'] == 'user' and r['target'] == 'gricha') for r in rq):
            want.append(n['id'])
    print(name, 'need detail for', len(want), flush=True)
    got = nodes_by_id(want, DETAIL, batch=40, tag=f'detail_{name}')
    for n in got:
        D[f"{n['repository']['nameWithOwner']}#{n['number']}"] = n
    json.dump(D, open(path, 'w'))
print('detail total', len(D))
