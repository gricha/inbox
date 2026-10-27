import json, os
from lib import *


def eng_times(n):
    t = [r['submittedAt'] or r['createdAt'] for r in n['myreviews']['nodes'] if (r['submittedAt'] or r['createdAt'])]
    t += [c['createdAt'] for c in n['comments']['nodes'] if (c['author'] or {}).get('login') == ME]
    return sorted(t)


def requests(n):
    out = []
    for t in n['timelineItems']['nodes']:
        if t['__typename'] not in ('ReviewRequestedEvent', 'ReviewRequestRemovedEvent'):
            continue
        rr = t.get('requestedReviewer') or {}
        tgt = ('user', rr.get('login')) if rr.get('__typename') in ('User', 'Bot') else ('team', rr.get('slug')) if rr.get('__typename') == 'Team' else (None, None)
        out.append(dict(at=t['createdAt'], removed=t['__typename'] == 'ReviewRequestRemovedEvent', kind=tgt[0], target=tgt[1],
                        actor=(t.get('actor') or {}).get('login')))
    return out


def load_engaged():
    E = json.load(open(os.path.join(DATA, 'engaged.json')))
    for k, n in E.items():
        n['_eng'] = eng_times(n)
        n['_first'] = n['_eng'][0] if n['_eng'] else None
    return E
