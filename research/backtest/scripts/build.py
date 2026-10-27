"""Build per-PR records for focus repos: requests, engagement, route, author kind, size, time-respecting affinity."""
import json, os, re, collections, datetime as dt
from lib import *
XTL = json.load(open(os.path.join(DATA, 'tl_extra.json'))) if os.path.exists(os.path.join(DATA, 'tl_extra.json')) else {}
from engaged_lib import load_engaged, requests

FOCUS = ['seer', 'sandbox-router', 'sentry', 'sentry_A', 'sentry_B', 'sentry_C', 'sentry_D', 'ops', 'getsentry']
E = load_engaged()
D = json.load(open(os.path.join(DATA, 'detail.json'))) if os.path.exists(os.path.join(DATA, 'detail.json')) else {}
O = Owners()
CONCEPTS = re.compile(r'agent[ _-]?token|viewer[ _-]?context|code[ _-]?mode|codemode|write approval|service account|seer-agent-token-flow|capability token', re.I)

# ---- gricha's own PRs (affinity source) ----
MINE = json.load(open(os.path.join(DATA, 'pop_mine.json'))); MINE.pop('_slices', None)
myprs = collections.defaultdict(list)
for k, n in MINE.items():
    files = [f['path'] for f in n['files']['nodes']]
    myprs[n['repository']['nameWithOwner']].append(dict(key=k, created=n['createdAt'], closed=n['closedAt'], merged=n['mergedAt'], files=files))

_aff_cache = {}


def my_index(repo, when, days=120):
    """Files/dirs/areas from gricha's PRs merged in [when-days, when). Cached per day."""
    day = when[:10]
    ck = (repo, day, days)
    if ck in _aff_cache:
        return _aff_cache[ck]
    lo = (ts(when) - dt.timedelta(days=days)).isoformat()[:10]
    F = collections.Counter()
    for p in myprs.get(repo, []):
        if p['merged'] and lo <= p['merged'][:10] < day:
            for f in p['files']:
                if not SKIP.search(f):
                    F[f] += 1
    dirs = collections.Counter(os.path.dirname(f) for f in F)
    dc = collections.Counter()
    for f in F:
        parts = f.split('/')
        for d in range(3, min(6, len(parts))):
            dc['/'.join(parts[:d]) + '/'] += 1
    areas = {a for a, c in dc.items() if c >= 3}
    _aff_cache[ck] = (F, dirs, areas)
    return _aff_cache[ck]


def open_mine(repo, when):
    return [p for p in myprs.get(repo, []) if p['created'] <= when and (not p['closed'] or p['closed'] > when)]


def affinity(repo, files, when):
    F, dirs, areas = my_index(repo, when)
    fs = [f for f in files if not SKIP.search(f)]
    w = sum((0.5 if is_test(f) else 1.0) for f in fs if f in F)
    fcount = sum(1 for f in fs if f in F)
    dcount = sum(1 for f in fs if os.path.dirname(f) in dirs)
    acount = sum(1 for f in fs if any(f.startswith(a) for a in areas))
    commits = sum(F[f] for f in fs)
    ov = [p['key'] for p in open_mine(repo, when) if set(fs) & set(x for x in p['files'] if not SKIP.search(x))]
    return dict(w_aff=w, f_aff=fcount, d_aff=dcount, a_aff=acount, aff_commits=commits, openov=ov,
                d_share=(dcount / len(fs)) if fs else 0.0)


def draft_at(n, when):
    evs = [(t['createdAt'], t['__typename']) for t in n['timelineItems']['nodes'] if t['__typename'] in ('ReadyForReviewEvent', 'ConvertToDraftEvent')]
    if evs:
        state = evs[0][1] == 'ReadyForReviewEvent'  # first event tells initial state
    else:
        state = n['isDraft']
    for at, typ in evs:
        if at <= when:
            state = typ == 'ConvertToDraftEvent'
    return state


recs = {}
for name in FOCUS:
    path = os.path.join(DATA, f'pop_{name}.json')
    if not os.path.exists(path):
        print('missing', name); continue
    P = json.load(open(path)); P.pop('_slices', None)
    for _k, _n in P.items():
        if _k in XTL: _n['timelineItems'] = XTL[_k]
    for k, n in P.items():
        if (n['author'] or {}).get('login') == ME:
            continue
        det = E.get(k) or D.get(k) or (n if 'files' in n else None)
        tl_src = E[k] if k in E and len(E[k]['timelineItems']['nodes']) >= len(n['timelineItems']['nodes']) else n
        rq = [r for r in requests(tl_src) if not r['removed']]
        ml = [r for r in rq if r['kind'] == 'team' and r['target'] == ML]
        myteam = [r for r in rq if r['kind'] == 'team' and r['target'] in MYTEAMS]
        direct = [r for r in rq if r['kind'] == 'user' and r['target'] == ME]
        ml_win = [r for r in ml if W0 <= r['at'] < W1]
        dir_win = [r for r in direct if W0 <= r['at'] < W1]
        if not (ml_win or dir_win or [r for r in myteam if W0 <= r['at'] < W1]):
            continue
        entry = min(r['at'] for r in (ml_win + dir_win + [r for r in myteam if W0 <= r['at'] < W1]))
        files = [f['path'] for f in det['files']['nodes']] if det else None
        reviews = det['reviews']['nodes'] if det else []
        e = E.get(k)
        first = e['_first'] if e else None
        akind = author_kind(n['author'])
        author = (n['author'] or {}).get('login') or 'ghost'
        body = (det or {}).get('body') or ''
        principal = None
        m = REQ_BY.search(body)
        if m and akind in ('sentry-junior', 'cursor', 'sentry', 'other-bot'):
            principal = m.group(1).strip()
        co_kind, co_lines = O.ml_route(n['repository']['nameWithOwner'], files or [], (ml_win or [dict(at=entry)])[0]['at']) if files is not None else ('unknown', [])
        ml_actor = ml_win[0]['actor'] if ml_win else None
        r = dict(key=k, repo=n['repository']['nameWithOwner'], number=n['number'], title=n['title'], created=n['createdAt'], closed=n['closedAt'],
                 merged=n['mergedAt'], author=author, akind=akind, principal=principal,
                 own_agent=bool(ME_NAMES.search(body)) and akind != 'human',
                 size=n['additions'] + n['deletions'], nfiles=n['changedFiles'], files=files,
                 entry=entry, ml_first=ml_win[0]['at'] if ml_win else None, ml_actor=ml_actor,
                 direct_first=direct[0]['at'] if direct else None, direct_actor=direct[0]['actor'] if direct else None,
                 direct_times=[r['at'] for r in direct],
                 team_events=[(r['at'], r['target']) for r in rq if r['kind'] == 'team'],
                 approvals=sorted(rv['submittedAt'] for rv in reviews if rv['state'] == 'APPROVED' and rv['submittedAt'] and (rv['author'] or {}).get('login') not in (ME, author)),
                 other_reviews=sorted(rv['submittedAt'] for rv in reviews if rv['submittedAt'] and (rv['author'] or {}).get('login') not in (ME, author)),
                 first_eng=first, eng_times=(e['_eng'] if e else []),
                 co_kind=co_kind, co_lines=co_lines,
                 concept=sorted(set(x.lower() for x in CONCEPTS.findall(n['title'] + ' ' + body[:3000]))),
                 has_detail=det is not None,
                 draft_at_entry=draft_at(tl_src, entry),
                 draft_evs=[(t['createdAt'], t['__typename'] == 'ConvertToDraftEvent') for t in tl_src['timelineItems']['nodes'] if t['__typename'] in ('ReadyForReviewEvent', 'ConvertToDraftEvent')],
                 draft0=draft_at(tl_src, '0000'),
                 req_times=sorted(r['at'] for r in rq if (r['kind'] == 'team' and r['target'] in MYTEAMS) or (r['kind'] == 'user' and r['target'] == ME)))
        if files is not None:
            r.update(affinity(r['repo'], files, entry))
        recs[k] = r
json.dump(recs, open(os.path.join(DATA, 'records.json'), 'w'))
C = collections.Counter
print('records', len(recs), C(r['repo'] for r in recs.values()))
print('missing detail', sum(not r['has_detail'] for r in recs.values()))
