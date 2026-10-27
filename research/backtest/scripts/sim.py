"""Q5: replay the proposed triage rules over the historical inbox.

Inbox item = PR (author != gricha) in focus repos with a review request to gricha or one of gricha's teams in the window.
Active from first such request until min(closed, gricha's first engagement, window end).
Signals are reconstructed at time t; CI state and mergeability are NOT reconstructable (assumed green / mergeable).
"""
import json, os, re, sys, collections, datetime as dt, statistics
from lib import *

R = json.load(open(os.path.join(DATA, 'records.json')))
E_ALL = json.load(open(os.path.join(DATA, 'engaged.json')))
recs = [r for r in R.values() if r['has_detail'] and r['files'] is not None]
TOP = ('NOW', 'TODAY')
ORDER = ['NOW', 'TODAY', 'LATER', 'FYI']

# ---- author engagement history (time-respecting collaborator prior) ----
from engaged_lib import eng_times
auth_eng = collections.defaultdict(list)  # author -> sorted first-engagement times (all repos, incl. unasked)
for k, n in E_ALL.items():
    t = eng_times(n)
    if t:
        auth_eng[(n['author'] or {}).get('login')].append(t[0])
for v in auth_eng.values():
    v.sort()


# author PR history in focus repos (denominator for rate-based prior)
_hist_path = os.path.join(DATA, 'author_prs.json')
if not os.path.exists(_hist_path):
    _h = collections.defaultdict(list)
    for _name in ['seer', 'sandbox-router', 'sentry', 'sentry_A', 'sentry_B', 'sentry_C', 'sentry_D', 'ops', 'getsentry']:
        _P = json.load(open(os.path.join(DATA, f'pop_{_name}.json'))); _P.pop('_slices', None)
        for _k, _n in _P.items():
            _h[(_n['author'] or {}).get('login')].append(_n['createdAt'])
    json.dump({k: sorted(v) for k, v in _h.items()}, open(_hist_path, 'w'))
AUTHOR_PRS = json.load(open(_hist_path))


def collab_rate(author, t, days=60):
    lo = (ts(t) - dt.timedelta(days=days)).isoformat().replace('+00:00', 'Z')
    n = sum(1 for x in AUTHOR_PRS.get(author, []) if lo <= x < t)
    e = sum(1 for x in auth_eng.get(author, []) if lo <= x < t)
    return e, n


def collab_count(author, t, days=28):
    lo = (ts(t) - dt.timedelta(days=days)).isoformat().replace('+00:00', 'Z')
    return sum(1 for x in auth_eng.get(author, []) if lo <= x < t)


# ---- stacks -> cards ----
def scope(title):
    m = re.match(r'\w+\(([^)]+)\)', title or '')
    return m.group(1).lower() if m else ''


def assign_cards(rs):
    g = collections.defaultdict(list)
    for r in sorted(rs, key=lambda r: r['entry']):
        key = 'dependabot:' + r['repo'] if r['akind'] == 'dependabot' else f"{r['author']}:{scope(r['title'])}"
        g[key].append(r)
    for key, v in g.items():
        start, idx = None, 0
        for r in v:
            if start is None or hours(start, r['entry']) > 72:
                start, idx = r['entry'], idx + 1
            r['card'] = f'{key}#{idx}'


assign_cards(recs)


# ---- signals at time t ----
def sig(r, t, V):
    direct_ts = [x for x in r['direct_times'] if x <= t]
    draft = r['draft0']
    for at, to_draft in r['draft_evs']:
        if at <= t:
            draft = to_draft
    teams = {tgt for at, tgt in r['team_events'] if at <= iso_plus(t, 60)}
    reqs = [x for x in r['req_times'] if x <= t]
    kind = 'dependabot' if r['akind'] == 'dependabot' else ('human' if r['akind'] == 'human' else 'agent')
    author = r['author']
    if V.get('principal') and kind == 'agent' and r.get('principal'):
        kind = 'human'
    collab = collab_count(author, t) if (V.get('collab') and (kind == 'human' or not V.get('collab_humans_only'))) else 0
    close = False
    if V.get('close') and r['akind'] == 'human':
        e_, n_ = collab_rate(author, t)
        close = e_ >= V.get('close_min', 3) and n_ > 0 and e_ / n_ >= V.get('close_rate', 0.3)
    s = dict(direct=bool(direct_ts), draft=draft, approved=any(a <= t for a in r['approvals']),
             age_d=(ts(t) - ts(r['created'])).days, nteams=len(teams), kind=kind, size=r['size'],
             w_aff=r['w_aff'], d_aff=r['d_aff'], a_aff=r['a_aff'], openov=bool(r['openov']), f_aff=r['f_aff'],
             since_req_d=(ts(t) - ts(reqs[-1])).days if reqs else 0, collab=collab, close=close,
             catchall=r['co_kind'] == 'catchall', concept=bool(r['concept']), own_agent=r['own_agent'])
    aff_key = V.get('aff', 'w')
    if aff_key == 'w':
        strong = s['w_aff'] >= V.get('aff_min', 1)
    elif aff_key == 'd':
        strong = s['d_aff'] >= V.get('aff_min', 1)
    s['strong'] = strong or s['openov']
    s['area'] = s['a_aff'] >= 1
    s['aff3'] = 'strong' if s['strong'] else ('area' if s['area'] else 'none')
    return s


def iso_plus(t, secs):
    return (ts(t) + dt.timedelta(seconds=secs)).isoformat().replace('+00:00', 'Z')


# ---- rule sets ----
def rules_bucket3(s, V):
    """scripts/bucket3.py logic (the dry run quoted in the brief)."""
    blocked = s['draft']
    if V.get('own_agent') and s['own_agent']:
        return 'NOW'
    if s['direct']:
        if blocked: return 'LATER'
        if s['aff3'] == 'strong' and s['size'] <= V.get('now_lines', 300): return 'NOW'
        return 'TODAY'
    if V.get('collab') and s['collab'] >= V.get('collab_min', 2) and not blocked:
        return 'TODAY'
    if V.get('close') and s['close'] and not blocked:
        return 'TODAY'
    if V.get('concept') and s['concept'] and not blocked:
        return 'TODAY'
    if s['openov']: return 'LATER' if blocked else 'TODAY'
    if s['kind'] == 'dependabot': return 'FYI'
    if s['age_d'] > V.get('stale_days', 45): return 'FYI'
    if s['approved']: return 'LATER' if s['w_aff'] >= 4 else 'FYI'
    if s['nteams'] >= V.get('fanout', 4) and not (V.get('fanout_keep_aff') and s['strong']): return 'FYI'
    if s['kind'] == 'agent' and s['w_aff'] < V.get('agent_aff', 2): return 'FYI'
    if blocked: return 'LATER' if s['aff3'] != 'none' else 'FYI'
    if s['aff3'] == 'strong': return 'TODAY'
    if s['aff3'] == 'area': return 'LATER'
    return 'FYI'


def rules_toml(s, V):
    """Literal TOML rule list from research.json triage-model details (first match wins, then invariant floor LATER)."""
    team_only = not s['direct']
    b = None
    if s['direct'] and not s['draft'] and s['w_aff'] >= 1 and s['size'] <= 300: b = 'NOW'
    elif s['draft']: b = 'LATER'
    elif s['openov']: b = 'TODAY'
    elif s['kind'] == 'dependabot' and not s['direct']: b = 'FYI'
    elif not s['direct'] and s['age_d'] > 45: b = 'FYI'
    elif team_only and s['approved'] and s['w_aff'] < 4: b = 'FYI'
    elif team_only and s['nteams'] >= 4: b = 'FYI'
    elif s['kind'] == 'agent' and not s['direct'] and s['w_aff'] < 2: b = 'FYI'
    elif team_only and s['w_aff'] >= 1: b = 'TODAY'
    elif team_only and s['area']: b = 'LATER'
    elif s['catchall'] and s['w_aff'] == 0 and not s['concept']: b = 'FYI'
    else: b = 'LATER'  # unspecified default
    if s['direct'] and ORDER.index(b) > ORDER.index('LATER'):
        b = 'LATER'
    return b


def score(s):
    x = 40 if s['direct'] else 0
    x += min(s['f_aff'], 6) * 6 + (15 if s['openov'] else 0) + (10 if s['kind'] == 'human' else 0)
    x += min(s['since_req_d'], 14) - (10 if s['size'] > 800 else 0)
    x += 12 if s['collab'] >= 2 else 0
    x += 30 if s.get('close') else 0
    return x


# ---- simulation ----
def end_time(r):
    ends = [W1]
    if r['closed']: ends.append(r['closed'])
    if r['first_eng'] and r['first_eng'] >= r['entry']: ends.append(r['first_eng'])
    return min(ends)


def run(name, fn, V, caps=(3, 8), step_min=30, quiet=False, period=(W0, W1)):
    items = [r for r in recs if r['entry'] < end_time(r)]
    # uncapped event-time evaluation (best bucket reached before cutoff)
    best = {}
    for r in items:
        cut = end_time(r)
        pts = [x for x in r['req_times'] if r['entry'] <= x < cut] + [at for at, d in r['draft_evs'] if not d and r['entry'] <= at < cut]
        pts = sorted(set(pts + [r['entry']]))
        bs = [fn(sig(r, t, V), V) for t in pts]
        best[r['key']] = (min(bs, key=ORDER.index), pts[[ORDER.index(b) for b in bs].index(min(ORDER.index(b) for b in bs))])
    # capped snapshots
    t = ts(W0)
    t_end = ts(W1)
    shown_first = {}
    weekly_cards = collections.defaultdict(set)
    weekly_prs = collections.defaultdict(set)
    screen = []
    items_sorted = sorted(items, key=lambda r: r['entry'])
    active = []
    i = 0
    while t < t_end:
        tiso = t.isoformat().replace('+00:00', 'Z')
        while i < len(items_sorted) and items_sorted[i]['entry'] <= tiso:
            active.append(items_sorted[i]); i += 1
        active = [r for r in active if end_time(r) > tiso]
        cards = {}
        for r in active:
            s = sig(r, tiso, V)
            b = fn(s, V)
            if b in TOP:
                c = cards.setdefault(r['card'], dict(b='TODAY', score=-1e9, prs=[], ck=r['card']))
                if b == 'NOW': c['b'] = 'NOW'
                c['score'] = max(c['score'], score(s)); c['prs'].append(r['key'])
        now = sorted([c for c in cards.values() if c['b'] == 'NOW'], key=lambda c: -c['score'])
        today = [c for c in cards.values() if c['b'] == 'TODAY'] + now[caps[0]:]
        today = sorted(today, key=lambda c: -c['score'])[:caps[1]]
        vis = now[:caps[0]] + today
        wk = week(tiso)
        for c in vis:
            for k in c['prs']:
                shown_first.setdefault(k, tiso)
                weekly_prs[wk].add(k)
            weekly_cards[wk].add(c['ck'])
        if t.weekday() < 5 and t.hour == 16 and t.minute == 0:
            screen.append((len(vis), len(cards)))
        t += dt.timedelta(minutes=step_min)
    # metrics
    p0, p1 = period
    eng = [r for r in items if r['first_eng'] and r['first_eng'] >= r['entry'] and p0 <= r['first_eng'] < p1]
    rec_unc = [r for r in eng if best[r['key']][0] in TOP]
    rec_cap = [r for r in eng if (r['key'] in shown_first and shown_first[r['key']] <= r['first_eng']) or
               (best[r['key']][0] in TOP and hours(r['entry'], r['first_eng']) < step_min / 60)]
    weeks = sorted({week(x) for x in (p0, iso_plus(p1, -1))})
    wk_all = sorted(w for w in weekly_cards if p0[:10] <= w < p1[:10]) or weeks
    full_weeks = [w for w in wk_all if '2026-05-04' <= w <= '2026-10-19']
    unc_new = collections.Counter()
    unc_cards = collections.defaultdict(set)
    for r in items:
        b, at = best[r['key']]
        if b in TOP and p0 <= at < p1:
            unc_new[week(at)] += 1; unc_cards[week(at)].add(r['card'])
    res = dict(name=name, eng_n=len(eng), recall_uncapped=round(len(rec_unc) / max(1, len(eng)), 3), recall_capped=round(len(rec_cap) / max(1, len(eng)), 3),
               wk_new_prs_uncapped=round(statistics.mean(unc_new[w] for w in full_weeks), 1) if full_weeks else None,
               wk_new_cards_uncapped=round(statistics.mean(len(unc_cards[w]) for w in full_weeks), 1) if full_weeks else None,
               wk_cards_shown_capped=round(statistics.mean(len(weekly_cards[w]) for w in full_weeks), 1) if full_weeks else None,
               wk_prs_shown_capped=round(statistics.mean(len(weekly_prs[w]) for w in full_weeks), 1) if full_weeks else None,
               screen_top2_cards_9amPT=round(statistics.mean(v for v, _ in screen), 1) if screen else None,
               screen_top2_uncapped_9amPT=round(statistics.mean(u for _, u in screen), 1) if screen else None,
               precision_shown=round(sum(1 for k in shown_first if R[k]['first_eng'] and R[k]['first_eng'] >= shown_first[k]) / max(1, len(shown_first)), 3),
               inbox_items=len(items))
    # recall by route
    def rt(r):
        return 'direct' if any(x <= r['first_eng'] for x in r['direct_times']) else 'team'
    for g in ('direct', 'team'):
        ge = [r for r in eng if rt(r) == g]
        res[f'recall_capped_{g}'] = f"{sum(1 for r in ge if r in rec_cap)}/{len(ge)}"
    res['_weekly'] = {w: (len(weekly_cards[w]), len(weekly_prs[w])) for w in full_weeks}
    res['_best'] = {k: v[0] for k, v in best.items()}
    res['_missed'] = [r['key'] for r in eng if r not in rec_cap]
    if not quiet:
        print(json.dumps({k: v for k, v in res.items() if not k.startswith('_')}))
    return res


VARIANTS = {
    'R0 bucket3.py (dry-run logic)': (rules_bucket3, {}),
    'R0t TOML literal': (rules_toml, {}),
}

if __name__ == '__main__':
    results = {}
    for name, (fn, V) in VARIANTS.items():
        results[name] = run(name, fn, V)
    json.dump({k: {kk: vv for kk, vv in v.items()} for k, v in results.items()}, open(os.path.join(DATA, 'sim_base.json'), 'w'), indent=0)
