# Backtest scripts

These scripts replay your past review requests (2026-05-01 to 10-26) against candidate triage rules. They produced every number in §1 of [docs/evidence.md](../../docs/evidence.md); §2–§5 come from the research run. This folder holds scripts only. The data they fetch contains internal PR metadata, so keep `data/` out of git.

## GitHub access: reads only
- `gql.py` is the only GraphQL caller. It runs `gh api graphql -f query=…`, which is an HTTP POST carrying a **query**. It asserts that the query text contains no `mutation`, and it stops if the remaining budget drops below 300 points.
- `fetch_codeowners.sh` runs two `gh api` GETs per snapshot (`commits?path=…` and `contents/.github/CODEOWNERS?ref=…`).
- Every other script reads local JSON only.
- Checked before copying (2026-10-26). No script posts, comments, reviews, marks notifications or changes anything.

## Re-run
Needs `gh` logged in with read access to getsentry, plus python3. A full run costs about 880 GraphQL points and 60 REST GETs.

Run these from `scripts/`. Output goes to `../data/`, which `gql.py` creates.
```sh
python3 fetch_engaged.py                       # PRs you reviewed or commented on → engaged.json
python3 fetch_population.py mine seer sandbox-router ops getsentry sentry
for s in A B C D; do echo '{"_slices":[]}' > ../data/pop_sentry_$s.json; done   # sentry was split A–D originally
NAMES="seer sandbox-router sentry sentry_A sentry_B sentry_C sentry_D ops getsentry"
python3 fetch_tl.py $NAMES                     # re-fetch truncated timelines → tl_extra.json
python3 fetch_detail.py $NAMES                 # files/reviews/body for ML-requested PRs → detail.json
mkdir -p ../data/codeowners && ./fetch_codeowners.sh
python3 build.py                               # per-PR records with as-of signals → records.json
python3 q1.py                                  # where engagement came from
python3 analyze.py                             # base rates, latency, affinity, AUC
python3 variants.py                            # rule variants, train/test split → variants_out.json
python3 robust.py; python3 watch.py; python3 misses.py
```
- Fetches are resumable: re-running a fetch skips the date slices it already has.
- To move the window, edit `W0`/`W1` in `lib.py`, plus the dates in `fetch_engaged.py`, `fetch_population.py` and `fetch_codeowners.sh`.
- To parallelize sentry (~14k PRs), run `sentry:A:<start>:<end>` … `sentry:D:…` as separate processes instead of `sentry`. Then create an empty `pop_sentry.json` the same way as the A–D files above.

## What each script outputs

| Script | Output |
|---|---|
| `q1.py` | Engagements per week, by source (direct, team, unasked) and by author |
| `analyze.py` | Base rates by repo, route, author kind and size; time to engage; affinity bands and AUC |
| `sim.py` | The replay engine. Run on its own, it prints R0 (dry-run rules) and R0t (literal TOML) |
| `variants.py` | One line per variant: capped recall, cards/wk, PRs/wk, on-screen at 9am, precision, train/test |
| `robust.py` | Recall slices for R0, P6 and P9 (azulus vs others, fast vs slow, seer vs sentry) |
| `watch.py` | Volume and engagement for the collab-watch source |
| `misses.py` | What R0 and P1 missed, by author, repo and affinity |
| `today_v2.py` | Today's queue under V1, from a snapshot JSON that isn't in the repo. Its `ci` is the check rollup standing in for required CI |

## Reproducing V1 (the shipped rules)
V1 is P9 plus two changes: a human direct ask goes to NOW (TODAY if the PR is a draft), and a bot-added direct ask is not treated as an ask but is floored at LATER. Run this from `scripts/`. It should print recall 0.795, 22.3 cards/wk, 6.2 on screen and precision 0.153:
```python
import sim
from sim import rules_bucket3, run

BOTS = {'sentry-junior', 'cursor', 'sentry'}
_sig = sim.sig

def sig_v1(r, t, V):
    s = _sig(r, t, V)
    a = r.get('direct_actor') or ''
    s['direct_human'] = s['direct'] and not (a in BOTS or a.endswith('[bot]'))
    return s

def rules_v1(s, V):
    if s['direct_human']:
        return 'TODAY' if s['draft'] else 'NOW'
    if s['direct']:
        b = rules_bucket3(dict(s, direct=False), V)
        return 'LATER' if b == 'FYI' else b
    return rules_bucket3(s, V)

sim.sig = sig_v1
P9 = dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1)
res = run('V1', rules_v1, P9, caps=(3, 6), quiet=True)
print({k: v for k, v in res.items() if not k.startswith('_')})
```
For the train/test split, `from sim import W0, W1` and pass `period=(W0, '2026-08-01T00:00:00Z')`, then `period=('2026-08-01T00:00:00Z', W1)`, to `run`. This is the golden reference for M1a's TypeScript `decide()`.
