import json, os, re, bisect, collections, datetime as dt

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
ME = 'gricha'
ML = 'machine-learning-ai'
MYTEAMS = {'machine-learning-ai', 'agent-platform', 'agent-platform-seer', 'agent-platform-sentry-backend'}
W0, W1 = '2026-05-01T00:00:00Z', '2026-10-27T00:00:00Z'
ME_NAMES = re.compile(r'requested by \*{0,2}(greg\.pstrucha|greg pstrucha|gricha)', re.I)
REQ_BY = re.compile(r'requested by \*{0,2}([^*\n.]+(?:\.[a-z]+)?)', re.I)


def ts(s):
    return dt.datetime.fromisoformat(s.replace('Z', '+00:00')) if s else None


def hours(a, b):
    return (ts(b) - ts(a)).total_seconds() / 3600


def week(s):
    d = ts(s).date()
    return (d - dt.timedelta(days=d.weekday())).isoformat()


# ---------- CODEOWNERS ----------
def pat2re(p):
    anchored = p.startswith('/') or '/' in p.rstrip('/')
    p2 = p.lstrip('/')
    dir_only = p2.endswith('/')
    p2 = p2.rstrip('/')
    out, i = '', 0
    while i < len(p2):
        if p2[i:i + 3] == '**/':
            out += '(?:.*/)?'; i += 3
        elif p2[i:i + 2] == '**':
            out += '.*'; i += 2
        elif p2[i] == '*':
            out += '[^/]*'; i += 1
        elif p2[i] == '?':
            out += '[^/]'; i += 1
        else:
            out += re.escape(p2[i]); i += 1
    prefix = '^' if anchored else '^(?:.*/)?'
    return re.compile(prefix + out + ('/.*$' if dir_only else '(?:/.*)?$'))


def parse_co(text):
    rules = []
    for line in text.splitlines():
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        parts = line.split()
        rules.append((parts[0], pat2re(parts[0]), [o.lstrip('@').split('/')[-1] for o in parts[1:]]))
    return rules


class Owners:
    """CODEOWNERS snapshots per repo, picked by request date."""
    def __init__(self):
        self.snaps = collections.defaultdict(list)
        idx = os.path.join(DATA, 'codeowners', 'index.tsv')
        cache = {}
        for line in open(idx):
            repo, date, sha = line.split()
            if sha not in cache:
                cache[sha] = parse_co(open(os.path.join(DATA, 'codeowners', f'{repo}_{sha}.txt')).read())
            self.snaps['getsentry/' + repo].append((date, cache[sha]))
        for v in self.snaps.values():
            v.sort()
        self.snaps['getsentry/sandbox-router'] = [('2000-01-01', parse_co('* @getsentry/machine-learning-ai'))]

    def rules_at(self, repo, when):
        v = self.snaps.get(repo)
        if not v:
            return None
        dates = [d for d, _ in v]
        i = max(0, bisect.bisect_right(dates, when[:10]) - 1)
        return v[i][1]

    def ml_route(self, repo, files, when):
        """'path' if a non-* line owning ML is the last match for some file, 'catchall' if ML only via '*', 'none' otherwise."""
        rules = self.rules_at(repo, when)
        if rules is None or not files:
            return 'unknown', []
        kinds, lines = set(), set()
        for f in files:
            last = None
            for pat, rx, owners in rules:
                if rx.match(f):
                    last = (pat, owners)
            if last and ML in last[1]:
                kinds.add('catchall' if last[0] in ('*', '/*', '**') else 'path')
                if last[0] not in ('*', '/*', '**'):
                    lines.add(last[0])
        if 'path' in kinds:
            return 'path', sorted(lines)
        if 'catchall' in kinds:
            return 'catchall', []
        return 'none', []


# ---------- authors ----------
AGENT_BOTS = {'sentry', 'sentry-junior', 'cursor', 'copilot-swe-agent', 'devin-ai-integration', 'claude', 'codex'}


def author_kind(a):
    login = (a or {}).get('login') or 'ghost'
    tn = (a or {}).get('__typename')
    if login.startswith('dependabot'):
        return 'dependabot'
    if login in ('sentry', 'sentry-junior', 'cursor'):
        return login
    if tn == 'Bot' or login.endswith('[bot]') or login in ('getsentry-bot', 'renovate', 'github-actions', 'codecov'):
        return 'other-bot'
    return 'human'


SKIP = re.compile(r'(uv\.lock|package-lock\.json|pnpm-lock\.yaml|call_title_lock\.json|generated|\.env\.example|schema\.json|AGENTS\.md|__init__\.py|conftest\.py|api/urls\.py|features/temporary\.py|conf/server\.py|CODEOWNERS|requirements.*\.txt|pyproject\.toml)')


def is_test(f):
    return '/test' in f or f.startswith('tests/') or '.spec.' in f or '_test.' in f


def size_bucket(n):
    for lim, lab in ((10, '<=10'), (50, '11-50'), (200, '51-200'), (500, '201-500'), (1000, '501-1000')):
        if n <= lim:
            return lab
    return '>1000'


def pctl(xs, ps=(25, 50, 75, 90)):
    xs = sorted(xs)
    if not xs:
        return {p: None for p in ps}
    return {p: xs[min(len(xs) - 1, int(round(p / 100 * (len(xs) - 1))))] for p in ps}
