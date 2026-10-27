"""Q1: engagement volume per week and where engagements came from."""
import json, collections, statistics
from engaged_lib import *
E = load_engaged()
C = collections.Counter
rows = []
for k, n in E.items():
    if not n['_first'] or not (W0 <= n['_first'] < W1):
        continue
    f = n['_first']
    author = (n['author'] or {}).get('login')
    akind = author_kind(n['author'])
    reqs = [r for r in requests(n) if not r['removed']]
    before = [r for r in reqs if r['at'] <= f]
    direct = [r for r in before if r['kind'] == 'user' and r['target'] == ME]
    team = [r for r in before if r['kind'] == 'team' and r['target'] in MYTEAMS]
    other = [r for r in before if not (r['kind'] == 'user' and r['target'] == ME) and not (r['kind'] == 'team' and r['target'] in MYTEAMS)]
    after_direct = [r for r in reqs if r['kind'] == 'user' and r['target'] == ME and r['at'] > f]
    own_agent = bool(ME_NAMES.search(n.get('body') or '')) and akind in ('sentry-junior', 'cursor', 'sentry', 'other-bot')
    if direct:
        d = direct[0]
        act = d['actor']
        ak = 'bot' if act in ('sentry-junior', 'cursor', 'sentry') or (act or '').endswith('[bot]') else ('author' if act == author else 'other-human')
        src = 'direct'
        sub = f'direct:{ak}'
    elif team:
        src = 'team-only'; sub = 'team:' + ','.join(sorted({r['target'] for r in team}))
    else:
        src = 'unasked'
        sub = 'unasked:own-agent-pr' if own_agent else ('unasked:other-teams-requested' if other else 'unasked:no-requests-at-all')
        if after_direct:
            sub += '+direct-after'
    rows.append(dict(key=k, repo=n['repository']['nameWithOwner'], week=week(f), first=f, src=src, sub=sub, author=author, akind=akind,
                     own_agent=own_agent, n_eng=len([t for t in n['_eng'] if W0 <= t < W1]),
                     weeks_active=sorted({week(t) for t in n['_eng'] if W0 <= t < W1})))
json.dump(rows, open(os.path.join(DATA, 'q1_rows.json'), 'w'), indent=0)
print('engaged PRs (first engagement in window):', len(rows))
print('by source:', C(r['src'] for r in rows))
print('by sub:', C(r['sub'] for r in rows).most_common())
print('own-agent PRs (junior requested by Greg):', sum(r['own_agent'] for r in rows), C(r['src'] for r in rows if r['own_agent']))
print('by repo x source:')
for repo, c in sorted(C(r['repo'] for r in rows).items(), key=lambda x: -x[1]):
    print(f'  {repo:40} {c:4}', dict(C(r['src'] for r in rows if r['repo'] == repo)))
wk = collections.defaultdict(C)
act = C()
for r in rows:
    wk[r['week']][r['src']] += 1
    for w in r['weeks_active']:
        act[w] += 1
weeks = sorted(set(wk) | set(act))
print('\nweek       new  direct team unasked | PRs-with-any-engagement')
for w in weeks:
    print(w, f"{sum(wk[w].values()):4} {wk[w]['direct']:6} {wk[w]['team-only']:4} {wk[w]['unasked']:7} | {act[w]}")
tot = [sum(wk[w].values()) for w in weeks]
print('weeks', len(weeks), 'mean new/wk', round(statistics.mean(tot), 1), 'median', statistics.median(tot), 'min', min(tot), 'max', max(tot))
print('mean active PRs/wk', round(statistics.mean(act[w] for w in weeks), 1))
print('top authors:', C(r['author'] for r in rows).most_common(12))
print('azulus by source', C(r['src'] for r in rows if r['author'] == 'azulus'))
print('author kind x source', C((r['akind'], r['src']) for r in rows).most_common())
