import json, collections
from sim import *
VS = [('R0', {}, (3, 8)), ('P6', dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1), (3, 8)),
      ('P9', dict(close=1, own_agent=1, principal=1, collab=1, collab_min=2, collab_humans_only=1), (3, 6))]
out = {}
for name, V, caps in VS:
    res = run(name, rules_bucket3, dict(V), caps=caps, quiet=True)
    items = [r for r in recs if r['entry'] < end_time(r)]
    eng = [r for r in items if r['first_eng'] and r['first_eng'] >= r['entry'] and W0 <= r['first_eng'] < W1]
    missed = set(res['_missed'])
    def rc(rows):
        return f"{sum(r['key'] not in missed for r in rows)}/{len(rows)} = {sum(r['key'] not in missed for r in rows)/max(1,len(rows)):.2f}"
    o = {
        'azulus': rc([r for r in eng if r['author'] == 'azulus']),
        'non-azulus': rc([r for r in eng if r['author'] != 'azulus']),
        'fast (<1h after request)': rc([r for r in eng if hours(r['entry'], r['first_eng']) < 1]),
        'slow (>=4h after request)': rc([r for r in eng if hours(r['entry'], r['first_eng']) >= 4]),
        'seer': rc([r for r in eng if r['repo'] == 'getsentry/seer']),
        'sentry': rc([r for r in eng if r['repo'] == 'getsentry/sentry']),
        'all 359 engagements (incl unasked)': f"{len(eng) - len(missed & {r['key'] for r in eng})}/359",
    }
    out[name] = o
    print(name, json.dumps(o))
json.dump(out, open(os.path.join(DATA, 'robust.json'), 'w'), indent=1)
