import json, collections, sys
from sim import *
C = collections.Counter
for name, V in [('R0', {}), ('P1', dict(collab=1, collab_min=2, own_agent=1, principal=1))]:
    res = run(name, rules_bucket3, V, quiet=True)
    best = res['_best']
    missed = [R[k] for k in res['_missed']]
    print(f'\n== {name}: missed {len(missed)}')
    def why(r):
        s = sig(r, r['entry'], V)
        b = rules_bucket3(s, V)
        return b
    print(' best bucket of missed:', C(best[r['key']] for r in missed))
    print(' missed by author:', C(r['author'] for r in missed).most_common(10))
    print(' missed by repo:', C(r['repo'] for r in missed).most_common())
    print(' missed w_aff:', C(('0' if r['w_aff'] == 0 else '<2' if r['w_aff'] < 2 else '2+') for r in missed))
    print(' missed hours entry->eng p50:', pctl([hours(r['entry'], r['first_eng']) for r in missed], (25, 50, 75)))
    # top-two noise: shown but never engaged, by author
    items = [r for r in recs if r['entry'] < end_time(r)]
    top_never = [r for r in items if best[r['key']] in TOP and not r['first_eng']]
    print(' top2 (uncapped) never engaged by author:', C(r['author'] for r in top_never).most_common(10))
    print(' top2 never engaged by repo:', C(r['repo'] for r in top_never).most_common())
    print(' FYI share of inbox:', round(sum(best[r['key']] == 'FYI' for r in items) / len(items), 2), 'LATER', round(sum(best[r['key']] == 'LATER' for r in items) / len(items), 2))
    print(' engaged items by best bucket:', C(best[r['key']] for r in items if r['first_eng'] and r['first_eng'] >= r['entry']))
