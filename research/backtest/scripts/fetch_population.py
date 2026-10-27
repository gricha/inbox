"""Population scan: all PRs created 2026-04-15..2026-10-26 in focus repos, plus gricha's own PRs since 2025-11-01."""
import json, os, sys, datetime as dt
sys.path.insert(0, os.path.dirname(__file__))
from gql import search_all, DATA
from frags import FULL, LIGHT, MINE

def ranges(start, end, days):
    s = dt.date.fromisoformat(start); e = dt.date.fromisoformat(end)
    while s <= e:
        t = min(e, s + dt.timedelta(days=days - 1)); yield s, t; s = t + dt.timedelta(days=1)

def scan(name, base_q, frag, start, end, days, page):
    path = os.path.join(DATA, f'pop_{name}.json')
    out = json.load(open(path)) if os.path.exists(path) else {}
    done = set(out.get('_slices', []))
    out.setdefault('_slices', [])
    stack = list(ranges(start, end, days))[::-1]
    while stack:
        s, t = stack.pop()
        key = f'{s}..{t}'
        if key in done: continue
        try:
            nodes, cnt = search_all(f'{base_q} created:{key}', frag, page_size=page, tag=f'{name}_{key}')
        except ValueError:
            mid = s + (t - s) / 2
            stack += [(mid + dt.timedelta(days=1), t), (s, mid)]
            continue
        for n in nodes:
            out[f"{n['repository']['nameWithOwner']}#{n['number']}"] = n
        out['_slices'].append(key)
        json.dump(out, open(path, 'w'))
        print(name, key, cnt, len(out) - 1, flush=True)

which = sys.argv[1:]
if 'mine' in which:
    scan('mine', 'is:pr org:getsentry author:gricha', MINE, '2025-11-01', '2026-10-26', 120, 50)
if 'seer' in which:
    scan('seer', 'is:pr repo:getsentry/seer', FULL, '2026-04-15', '2026-10-26', 31, 25)
if 'sandbox-router' in which:
    scan('sandbox-router', 'is:pr repo:getsentry/sandbox-router', FULL, '2026-04-15', '2026-10-26', 200, 25)
if 'sentry' in which:
    scan('sentry', 'is:pr repo:getsentry/sentry', LIGHT, '2026-04-15', '2026-10-26', 7, 40)
if 'ops' in which:
    scan('ops', 'is:pr repo:getsentry/ops', LIGHT, '2026-04-15', '2026-10-26', 15, 40)
if 'getsentry' in which:
    scan('getsentry', 'is:pr repo:getsentry/getsentry', LIGHT, '2026-04-15', '2026-10-26', 31, 40)
for arg in which:
    if arg.startswith('sentry:'):
        _, tag, s, e = arg.split(':')
        scan(f'sentry_{tag}', 'is:pr repo:getsentry/sentry', LIGHT, s, e, 7, 40)
