"""Read-only GraphQL helper: queries only (rejects mutations), logs cost, retries."""
import json, subprocess, time, os, sys

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, 'data')
RAW = os.path.join(DATA, 'raw')
os.makedirs(RAW, exist_ok=True)
COSTLOG = os.path.join(DATA, 'cost_log.tsv')


def gql(query, **vars):
    assert 'mutation' not in query.lower(), 'read-only'
    args = ['gh', 'api', 'graphql', '-f', f'query={query}']
    for k, v in vars.items():
        if v is None:
            continue
        flag = '-F' if isinstance(v, int) else '-f'
        args += [flag, f'{k}={v}']
    for attempt in range(6):
        p = subprocess.run(args, capture_output=True, text=True)
        try:
            out = json.loads(p.stdout) if p.stdout.strip() else {}
        except json.JSONDecodeError:
            out = {}
        errs = out.get('errors') or ([] if p.returncode == 0 else [{'message': p.stderr[:500]}])
        if out.get('data') and not errs:
            rl = out['data'].get('rateLimit') or {}
            with open(COSTLOG, 'a') as f:
                f.write(f"{time.strftime('%H:%M:%S')}\t{rl.get('cost')}\t{rl.get('remaining')}\t{json.dumps(vars)[:120]}\n")
            if rl.get('remaining', 5000) < 300:
                print('LOW GRAPHQL BUDGET, stopping', rl, file=sys.stderr)
                sys.exit(2)
            return out['data']
        msg = json.dumps(errs)[:400]
        print(f'  retry {attempt}: {msg}', file=sys.stderr)
        if out.get('data') and errs and all(e.get('type') == 'NOT_FOUND' for e in errs):
            return out['data']
        time.sleep(min(60, 5 * (2 ** attempt)))
    raise RuntimeError(msg)


def search_all(q, fragment, page_size=50, tag=None):
    """Paginate a GraphQL ISSUE search; returns nodes; asserts < 1000 results."""
    query = '''query($q:String!, $after:String, $n:Int!){
  search(type:ISSUE, query:$q, first:$n, after:$after){ issueCount pageInfo{hasNextPage endCursor} nodes{ %s } }
  rateLimit{cost remaining}
}''' % fragment
    nodes, after, page = [], None, 0
    while True:
        d = gql(query, q=q, after=after, n=page_size)
        s = d['search']
        if page == 0 and s['issueCount'] > 1000:
            raise ValueError(f'slice too big ({s["issueCount"]}): {q}')
        nodes += s['nodes']
        if tag:
            with open(os.path.join(RAW, f'{tag}_p{page}.json'), 'w') as f:
                json.dump(s, f)
        page += 1
        if not s['pageInfo']['hasNextPage']:
            return nodes, s['issueCount']
        after = s['pageInfo']['endCursor']
        time.sleep(1.0)


def nodes_by_id(ids, fragment, batch=50, tag=None):
    query = '''query($ids:[ID!]!){ nodes(ids:$ids){ ... on PullRequest { %s } } rateLimit{cost remaining} }''' % fragment
    out = []
    for i in range(0, len(ids), batch):
        chunk = ids[i:i + batch]
        args_ids = json.dumps(chunk)
        # gh -f can't pass arrays; inline the ids
        q = query.replace('query($ids:[ID!]!)', 'query').replace('nodes(ids:$ids)', f'nodes(ids:{args_ids})')
        d = gql(q)
        out += [n for n in d['nodes'] if n]
        if tag:
            with open(os.path.join(RAW, f'{tag}_b{i // batch}.json'), 'w') as f:
                json.dump(d['nodes'], f)
        time.sleep(0.5)
    return out
