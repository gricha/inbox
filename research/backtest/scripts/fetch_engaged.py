import json, os, sys
sys.path.insert(0, os.path.dirname(__file__))
from gql import search_all, DATA
from frags import ENGAGED
out = {}
for name in ['reviewed-by', 'commenter']:
    q = f'is:pr org:getsentry {name}:gricha -author:gricha updated:>=2026-05-01'
    nodes, cnt = search_all(q, ENGAGED, page_size=50, tag=f'engaged_{name}')
    print(name, cnt, len(nodes))
    for n in nodes:
        n.setdefault('_via', [])
        key = f"{n['repository']['nameWithOwner']}#{n['number']}"
        if key in out:
            out[key]['_via'].append(name)
        else:
            n['_via'] = [name]; out[key] = n
json.dump(out, open(os.path.join(DATA, 'engaged.json'), 'w'))
print('union', len(out))
