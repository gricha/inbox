"""Today's 117 under the shipped V1 rules (P9 + human-ask NOW + bot-ask floor LATER, P9 score). Read-only (local JSON only).
Usage: python3 today_v2.py <today-snapshot.json> [--first-run]. The snapshot is not in the repo (internal PR metadata).
Note: `ci` is statusCheckRollup, standing in for required CI, so "blocked" is approximate."""
import json, sys, collections, re

d = json.load(open(sys.argv[1]))
FIRST_RUN = '--first-run' in sys.argv
COLLAB28 = {'vaind': 10, 'sehr-m': 8, 'NicoHinderling': 8, 'azulus': 4, 'shruthilayaj': 3, 'rbro112': 2, 'sebastianv1': 2, 'arslnb': 2}
CLOSE = {'azulus'}
ORDER = ['NOW', 'TODAY', 'LATER', 'FYI']
BOTS = ('sentry-junior', 'cursor', 'sentry')


def rule(x):
    human = x['kind'] == 'human'
    blocked = x['draft'] or x['ci'] == 'FAILURE' or x['mergeable'] == 'CONFLICTING'
    human_ask = x['direct'] and x['req_by'] not in BOTS
    strong = x['w_aff'] >= 1 or bool(x['openov'])
    if human_ask and not x['draft']:
        return 'NOW', 'human-ask'
    if human and x['author'] in CLOSE and not blocked:
        return 'TODAY', 'close-collaborator'
    if human and COLLAB28.get(x['author'], 0) >= 2 and not blocked:
        return 'TODAY', 'recent-collaborator'
    if x['openov'] and not blocked:
        return 'TODAY', 'overlaps-my-pr'
    if FIRST_RUN and not human_ask and x['since_req_d'] > 14 and x['idle_d'] > 14:
        return 'FYI', 'first-run'
    if x['kind'] == 'dependabot':
        return 'FYI', 'dependabot'
    if x['age_d'] > 45:
        return 'FYI', 'stale'
    if x['others_appr']:
        return 'FYI', 'approved-by-others'
    if x['nteams'] >= 4:
        return 'FYI', 'fanout'
    if x['kind'] != 'human' and x['w_aff'] < 2:
        return 'FYI', 'agent-low-aff'
    if blocked:
        return ('LATER' if strong else 'FYI'), 'blocked'
    if strong:
        return 'TODAY', 'team-my-files'
    return 'FYI', 'default'


def score(x):
    s = 40 if x['direct'] else 0
    s += min(x['f_aff'], 6) * 6 + (15 if x['openov'] else 0) + (10 if x['kind'] == 'human' else 0)
    s += min(x['since_req_d'], 14) - (10 if x['size'] > 800 else 0)
    s += 12 if COLLAB28.get(x['author'], 0) >= 2 else 0
    s += 30 if x['author'] in CLOSE else 0
    return s


def card_key(x):
    if x['direct'] and x['req_by'] == 'sentry-junior':
        return f"series:{x['author']}<-{x['req_by']}"
    if x['kind'] == 'dependabot':
        return 'dependabot:' + x['repo']
    m = re.match(r'\w+\(([^)]+)\)', x['title'] or '')
    return f"{x['author']}:{m.group(1).lower() if m else x['key']}"


cards = {}
for x in d:
    b, r = rule(x)
    bot_ask = x['direct'] and x['req_by'] in BOTS
    if (bot_ask or (x['direct'] and x['draft'])) and ORDER.index(b) > ORDER.index('LATER' if bot_ask else 'TODAY'):
        b, r = ('LATER' if bot_ask else 'TODAY'), r + '+floor'
    k = card_key(x)
    c = cards.setdefault(k, dict(k=k, b='FYI', prs=[], mb=[], score=-1e9, rules=collections.Counter(), protected=False))
    if ORDER.index(b) < ORDER.index(c['b']):
        c['b'] = b
    c['prs'].append(x['key']); c['mb'].append((b, r, x['key'], x['title'][:50], x['size'], x['ci']))
    c['score'] = max(c['score'], score(x))
    c['rules'][r] += 1
    if x['direct'] and x['req_by'] not in BOTS:
        c['protected'] = True

prot = [c for c in cards.values() if c['b'] == 'NOW' and c['protected']]
now = sorted([c for c in cards.values() if c['b'] == 'NOW' and not c['protected']], key=lambda c: -c['score'])
today = sorted([c for c in cards.values() if c['b'] == 'TODAY'] + now[3:], key=lambda c: -c['score'])
now = sorted(prot, key=lambda c: -c['score']) + now[:3]
over, today = today[6:], today[:6]
for name, lst in (('NOW', now), ('TODAY', today), ('OVER CAP -> LATER', over)):
    print(f'== {name} {len(lst)} cards / {sum(len(c["prs"]) for c in lst)} PRs')
    for c in lst:
        top = [m for m in c['mb'] if m[0] == c['b']]
        fyi = sum(1 for m in c['mb'] if m[0] == 'FYI')
        print(f'  {c["score"]:>4} {c["k"]:42} {len(c["prs"]):>2} PRs (at bucket {len(top)}, +{fyi} FYI) {dict(c["rules"])}')
        for m in top[:3]:
            print('        ', m)
rest = collections.Counter(); prs = collections.Counter()
for c in cards.values():
    if c['b'] in ('LATER', 'FYI'):
        rest[c['b']] += 1; prs[c['b']] += len(c['prs'])
print('LATER/FYI cards', dict(rest), 'PRs', dict(prs), '| total cards', len(cards))
# audit: hidden cards (FYI) by deciding rule = most common member rule at card bucket
aud = collections.defaultdict(lambda: [0, 0])
for c in cards.values():
    if c['b'] in ('FYI', 'LATER'):
        rr = collections.Counter(m[1] for m in c['mb'] if m[0] == c['b']).most_common(1)[0][0]
        aud[(c['b'], rr)][0] += 1; aud[(c['b'], rr)][1] += len(c['prs'])
for k, v in sorted(aud.items(), key=lambda kv: (kv[0][0], -kv[1][0])):
    print('  audit', k, 'cards', v[0], 'PRs', v[1])
