"""Unasked engagements: would a 'watch collaborators' source (authors gricha engaged >=k times in prior 28d) catch them, at what volume?"""
import json, os, collections, statistics
from lib import *
from engaged_lib import load_engaged, requests
from sim import collab_count
E = load_engaged()
XTL = json.load(open(os.path.join(DATA, 'tl_extra.json')))
C = collections.Counter
allp = {}
for name in ['seer', 'sandbox-router', 'sentry', 'sentry_A', 'sentry_B', 'sentry_C', 'sentry_D', 'ops', 'getsentry']:
    P = json.load(open(os.path.join(DATA, f'pop_{name}.json'))); P.pop('_slices', None)
    for k, n in P.items():
        if k in XTL: n['timelineItems'] = XTL[k]
        allp[k] = n
for kmin in (2, 3, 5):
    cand = []
    for k, n in allp.items():
        a = (n['author'] or {}).get('login')
        if a == ME or not (W0 <= n['createdAt'] < W1):
            continue
        rq = [r for r in requests(n) if not r['removed']]
        asked = [r for r in rq if (r['kind'] == 'team' and r['target'] in MYTEAMS) or (r['kind'] == 'user' and r['target'] == ME)]
        if asked:
            continue  # already in the request-based inbox
        if collab_count(a, n['createdAt']) >= kmin:
            e = E.get(k)
            cand.append((k, a, n['createdAt'], bool(e and e['_first'] and e['_first'] >= n['createdAt'])))
    wk = C(week(c[2]) for c in cand)
    weeks = [w for w in sorted(set(week(x['createdAt']) for x in allp.values() if W0 <= x['createdAt'] < W1)) if '2026-05-04' <= w <= '2026-10-19']
    eng = sum(c[3] for c in cand)
    print(f'collab>={kmin}: unrequested PRs by collaborators {len(cand)} ({statistics.mean(wk[w] for w in weeks):.1f}/wk), engaged {eng} ({100*eng/max(1,len(cand)):.0f}%), by author', C(c[1] for c in cand).most_common(6), 'engaged by author', C(c[1] for c in cand if c[3]).most_common(6))
# all unasked engagements in focus repos (any author)
un = [k for k, e in E.items() if e['_first'] and W0 <= e['_first'] < W1 and k in allp and not [r for r in requests(allp[k]) if not r['removed'] and r['at'] <= e['_first'] and ((r['kind'] == 'team' and r['target'] in MYTEAMS) or (r['kind'] == 'user' and r['target'] == ME))]]
print('unasked engagements in focus repos:', len(un))

# rate-based close collaborators (humans only): >=3 engagements and >=X% of their focus-repo PRs in prior 60d
from sim import collab_rate
for rate in (0.3, 0.15):
    cand = []
    for k, n in allp.items():
        a = (n['author'] or {}).get('login')
        if a == ME or not (W0 <= n['createdAt'] < W1) or author_kind(n['author']) != 'human':
            continue
        rq = [r for r in requests(n) if not r['removed']]
        if [r for r in rq if (r['kind'] == 'team' and r['target'] in MYTEAMS) or (r['kind'] == 'user' and r['target'] == ME)]:
            continue
        e_, n_ = collab_rate(a, n['createdAt'])
        if e_ >= 3 and n_ and e_ / n_ >= rate:
            e = E.get(k)
            cand.append((k, a, n['createdAt'], bool(e and e['_first'] and e['_first'] >= n['createdAt']), n['repository']['nameWithOwner']))
    wk = C(week(c[2]) for c in cand)
    weeks = [w for w in sorted(set(week(x['createdAt']) for x in allp.values() if W0 <= x['createdAt'] < W1)) if '2026-05-04' <= w <= '2026-10-19']
    eng = sum(c[3] for c in cand)
    print(f'close>= {rate}: unrequested PRs {len(cand)} ({statistics.mean(wk[w] for w in weeks):.1f}/wk), engaged {eng} ({100*eng/max(1,len(cand)):.0f}%) of {len(un)} unasked focus-repo engagements;',
          C(c[1] for c in cand).most_common(5), 'engaged:', C(c[1] for c in cand if c[3]).most_common(5), C(c[4] for c in cand).most_common(3))
