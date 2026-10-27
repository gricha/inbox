"""Q5: base rules vs proposed changes; full window + time split (tune May-Jul, test Aug-Oct)."""
import json, os, sys
from sim import run, rules_bucket3, rules_toml, DATA, W0, W1
SPLIT = '2026-08-01T00:00:00Z'
V = [
    ('R0  bucket3.py as dry-run', rules_bucket3, {}),
    ('R0t TOML literal', rules_toml, {}),
    ('+own-agent PRs -> NOW', rules_bucket3, dict(own_agent=1)),
    ('+principal: agent PR w/ human requester = human', rules_bucket3, dict(principal=1)),
    ('+collab>=1 (28d) -> TODAY', rules_bucket3, dict(collab=1, collab_min=1)),
    ('+collab>=2 (28d) -> TODAY', rules_bucket3, dict(collab=1, collab_min=2)),
    ('+collab>=3 (28d) -> TODAY', rules_bucket3, dict(collab=1, collab_min=3)),
    ('aff: dir-level d_aff>=1', rules_bucket3, dict(aff='d', aff_min=1)),
    ('aff: dir-level d_aff>=2', rules_bucket3, dict(aff='d', aff_min=2)),
    ('aff: w_aff>=2 (stricter)', rules_bucket3, dict(aff='w', aff_min=2)),
    ('agent-low-aff threshold 1', rules_bucket3, dict(agent_aff=1)),
    ('fan-out keeps strong-affinity', rules_bucket3, dict(fanout_keep_aff=1)),
    ('+concept keyword -> TODAY (A1 proxy)', rules_bucket3, dict(concept=1)),
    ('NOW lines 600', rules_bucket3, dict(now_lines=600)),
    ('TODAY cap 5', rules_bucket3, dict(_caps=(3, 5))),
    ('TODAY cap 12', rules_bucket3, dict(_caps=(3, 12))),
    ('P1 = collab>=2 + own-agent + principal', rules_bucket3, dict(collab=1, collab_min=2, own_agent=1, principal=1)),
    ('P2 = P1 + w_aff>=2', rules_bucket3, dict(collab=1, collab_min=2, own_agent=1, principal=1, aff='w', aff_min=2)),
    ('P3 = P1 + d_aff>=2', rules_bucket3, dict(collab=1, collab_min=2, own_agent=1, principal=1, aff='d', aff_min=2)),
    ('P4 = P1 + d_aff>=1', rules_bucket3, dict(collab=1, collab_min=2, own_agent=1, principal=1, aff='d', aff_min=1)),
    ('+collab>=2 humans only -> TODAY', rules_bucket3, dict(collab=1, collab_min=2, collab_humans_only=1)),
    ('+close collaborator (>=3 eng, >=30% of their PRs, 60d)', rules_bucket3, dict(close=1)),
    ('+close collaborator (>=3 eng, >=15%, 60d)', rules_bucket3, dict(close=1, close_rate=0.15)),
    ('P5 = close30 + own-agent + principal', rules_bucket3, dict(close=1, own_agent=1, principal=1)),
    ('P6 = P5 + collab>=2 humans', rules_bucket3, dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1)),
    ('P7 = P6 + fan-out keeps affinity + agent-aff 1', rules_bucket3, dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1, fanout_keep_aff=1, agent_aff=1)),
    ('P8 = P5, TODAY cap 6', rules_bucket3, dict(close=1, own_agent=1, principal=1, _caps=(3, 6))),
    ('P9 = P6, TODAY cap 6', rules_bucket3, dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1, _caps=(3, 6))),
]
only = sys.argv[1:]
rows = []
for name, fn, v in V:
    if only and not any(o in name for o in only):
        continue
    caps = v.pop('_caps', (3, 8))
    full = run(name, fn, v, caps=caps, quiet=True)
    tr = run(name, fn, v, caps=caps, quiet=True, period=(W0, SPLIT))
    te = run(name, fn, v, caps=caps, quiet=True, period=(SPLIT, W1))
    rows.append(dict(name=name, full={k: x for k, x in full.items() if not k.startswith('_')}, train={k: x for k, x in tr.items() if not k.startswith('_')},
                     test={k: x for k, x in te.items() if not k.startswith('_')}, missed=full['_missed']))
    f, a, b = full, tr, te
    print(f"{name:48} recall cap {f['recall_capped']:.2f} (unc {f['recall_uncapped']:.2f}) dir {f['recall_capped_direct']:>6} team {f['recall_capped_team']:>7} | "
          f"cards/wk {f['wk_cards_shown_capped']:5} PRs/wk {f['wk_prs_shown_capped']:5} new/wk unc {f['wk_new_prs_uncapped']:5} | on-screen {f['screen_top2_cards_9amPT']} | prec {f['precision_shown']:.2f} | "
          f"train {a['recall_capped']:.2f}/{a['wk_cards_shown_capped']} test {b['recall_capped']:.2f}/{b['wk_cards_shown_capped']}", flush=True)
json.dump(rows, open(os.path.join(DATA, 'variants_out.json'), 'w'), indent=1)
