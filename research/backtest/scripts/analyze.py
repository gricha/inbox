"""Q2 base rates, Q3 time-to-engagement, Q4 file affinity. Reads data/records.json."""
import json, os, collections, statistics
from lib import *

R = json.load(open(os.path.join(DATA, 'records.json')))
C = collections.Counter
CENSOR = '2026-10-12T00:00:00Z'  # requests after this have <14d to be engaged
out = {}


def route(r):
    first = r['first_eng'] or W1
    if r['direct_first'] and r['direct_first'] <= first:
        return 'direct'
    if r['co_kind'] == 'catchall':
        return 'team:catchall'
    if r['co_kind'] == 'path':
        return 'team:path'
    return 'team:manual/other'


def engaged(r):
    return bool(r['first_eng'])


def table(rows, keyf, title, min_n=1, sort_by_n=True):
    g = collections.defaultdict(list)
    for r in rows:
        g[keyf(r)].append(r)
    lines = []
    items = sorted(g.items(), key=lambda kv: -len(kv[1])) if sort_by_n else sorted(g.items())
    for k, v in items:
        if len(v) < min_n:
            continue
        e = sum(engaged(r) for r in v)
        lines.append((k, len(v), e, round(100 * e / len(v), 1)))
    print(f'\n## {title}\n  {"group":38} {"N":>5} {"eng":>4} {"rate%":>6}')
    for k, n, e, p in lines:
        print(f'  {str(k):38} {n:5} {e:4} {p:6}')
    out[title] = lines
    return lines


# ---------------- Q2 ----------------
pop = [r for r in R.values() if r['ml_first'] and W0 <= r['ml_first'] < W1]
print('ML-team-requested population (request in window, author != gricha):', len(pop), 'with file detail:', sum(r['has_detail'] for r in pop))
table(pop, lambda r: 'ALL', 'overall')
table([r for r in pop if r['ml_first'] < CENSOR], lambda r: 'ALL (requests before 10-12)', 'overall, censor-safe')
table(pop, lambda r: r['repo'], 'by repo')
table(pop, route, 'by route')
table(pop, lambda r: (r['repo'].split('/')[1], route(r)), 'by repo x route')
table(pop, lambda r: r['akind'], 'by author kind')
table([r for r in pop if r['akind'] == 'human'], lambda r: r['author'], 'top human authors (n>=15)', min_n=15)
table(pop, lambda r: size_bucket(r['size']), 'by size (additions+deletions)')
table([r for r in pop if r['akind'] == 'human'], lambda r: size_bucket(r['size']), 'by size, human authors only')
table(pop, lambda r: (r['ml_first'][:7]), 'by request month', sort_by_n=False)
table([r for r in pop if r['repo'] == 'getsentry/sentry'], lambda r: (r['co_lines'][0] if r['co_lines'] else '(no ML line matched)'), 'sentry: first matched ML CODEOWNERS line', min_n=8)
table(pop, lambda r: ('engaged before request' if r['first_eng'] and r['first_eng'] < r['ml_first'] else 'engaged after request' if r['first_eng'] else 'not engaged'), 'engagement timing vs ML request')

# direct population
dpop = [r for r in R.values() if r['direct_first'] and W0 <= r['direct_first'] < W1]
table(dpop, lambda r: r['repo'], 'DIRECT-requested PRs by repo')
table(dpop, lambda r: ('bot' if r['direct_actor'] in ('sentry-junior', 'cursor', 'sentry') else 'author' if r['direct_actor'] == r['author'] else 'other human'), 'DIRECT by requester kind')

# ---------------- Q3 ----------------
print('\n## Q3 time to engagement (hours)')
def dist(xs, label):
    p = pctl(xs, (10, 25, 50, 75, 90))
    w = lambda h: round(100 * sum(x <= h for x in xs) / len(xs), 1) if xs else None
    print(f'  {label:42} n={len(xs):4} p10={p[10] and round(p[10],1)} p25={p[25] and round(p[25],1)} p50={p[50] and round(p[50],1)} p75={p[75] and round(p[75],1)} p90={p[90] and round(p[90],1)} | <=4h {w(4)}% <=24h {w(24)}% <=72h {w(72)}% <=7d {w(168)}%')
    out[f'q3 {label}'] = dict(n=len(xs), p=p, le4=w(4), le24=w(24), le72=w(72), le168=w(168))
dd, tt, tt_seer, tt_sentry, dd_last = [], [], [], [], []
for r in R.values():
    f = r['first_eng']
    if not f or not (W0 <= f < W1):
        continue
    dts = [t for t in r['direct_times'] if t <= f]
    if dts:
        dd.append(hours(dts[0], f)); dd_last.append(hours(dts[-1], f))
    elif r['ml_first'] and r['ml_first'] <= f:
        h = hours(r['ml_first'], f); tt.append(h)
        (tt_seer if r['repo'] == 'getsentry/seer' else tt_sentry if r['repo'] == 'getsentry/sentry' else []).append(h)
dist(dd, 'direct (first direct request -> first eng)')
dist(dd_last, 'direct (latest direct request -> first eng)')
dist(tt, 'team-only (first ML request -> first eng)')
dist(tt_seer, 'team-only seer')
dist(tt_sentry, 'team-only sentry')
# unanswered direct asks
und = [r for r in dpop if not r['first_eng']]
print('  direct asks in window never engaged:', len(und), 'of', len(dpop), [(r['key'], r['direct_actor']) for r in und][:20])

# ---------------- Q4 ----------------
fp = [r for r in pop if r['has_detail'] and r['files'] is not None]
def wb(x):
    return '0' if x == 0 else '0<w<1' if x < 1 else '1-2' if x < 3 else '3-5' if x < 6 else '6+'
table(fp, lambda r: wb(r['w_aff']), 'Q4 weighted file affinity (merged PRs by gricha, prior 120d)', sort_by_n=False)
table(fp, lambda r: wb(r['d_aff']), 'Q4 dir affinity (files in dirs gricha changed, prior 120d)', sort_by_n=False)
table(fp, lambda r: ('none' if r['d_share'] == 0 else '<25%' if r['d_share'] < .25 else '25-50%' if r['d_share'] < .5 else '50-99%' if r['d_share'] < 1 else '100%'), 'Q4 share of PR files in dirs gricha changed', sort_by_n=False)
table(fp, lambda r: wb(r['a_aff']), 'Q4 area affinity (prefix with >=3 files by gricha)', sort_by_n=False)
table(fp, lambda r: bool(r['openov']), 'Q4 overlaps an open PR by gricha')
table(fp, lambda r: bool(r['concept']), 'Q4 concept keyword hit (title/body)')
for repo in ('getsentry/seer', 'getsentry/sentry'):
    table([r for r in fp if r['repo'] == repo], lambda r: wb(r['d_aff']), f'Q4 dir affinity within {repo}', sort_by_n=False)
table([r for r in fp if r['author'] != 'azulus'], lambda r: wb(r['d_aff']), 'Q4 dir affinity excluding azulus', sort_by_n=False)
table([r for r in fp if r['author'] == 'azulus'], lambda r: wb(r['d_aff']), 'Q4 dir affinity azulus only', sort_by_n=False)
table([r for r in fp if r['akind'] == 'human' and r['author'] != 'azulus'], lambda r: wb(r['w_aff']), 'Q4 file affinity, humans excl. azulus', sort_by_n=False)


def auc(rows, f):
    pos = [f(r) for r in rows if engaged(r)]; neg = [f(r) for r in rows if not engaged(r)]
    if not pos or not neg:
        return None
    s = 0
    for p in pos:
        for q in neg:
            s += 1 if p > q else 0.5 if p == q else 0
    return round(s / (len(pos) * len(neg)), 3)


print('\n## Q4 single-feature AUC (engaged vs not), ML population with files')
for name, f in [('w_aff', lambda r: r['w_aff']), ('f_aff', lambda r: r['f_aff']), ('d_aff', lambda r: r['d_aff']), ('d_share', lambda r: r['d_share']),
                ('a_aff', lambda r: r['a_aff']), ('aff_commits', lambda r: r['aff_commits']), ('openov', lambda r: len(r['openov'])),
                ('concept', lambda r: len(r['concept'])), ('-size', lambda r: -r['size'])]:
    a_all = auc(fp, f); a_nz = auc([r for r in fp if r['author'] != 'azulus'], f); a_seer = auc([r for r in fp if r['repo'] == 'getsentry/seer'], f)
    print(f'  {name:12} all={a_all}  excl-azulus={a_nz}  seer-only={a_seer}')
    out[f'auc {name}'] = (a_all, a_nz, a_seer)
json.dump(out, open(os.path.join(DATA, 'analyze_out.json'), 'w'), indent=1, default=str)
