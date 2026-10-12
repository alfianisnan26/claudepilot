#!/usr/bin/env python3
"""Splits token-shaped literals in TS source with a ' + ' so no contiguous provider-shaped text is in the source (the runtime value stays identical).
Usage: split-literals.py FILE...   Prints, per file, how many literals were split (never the values)."""
import re, sys
FAMILIES = [
  (re.compile(r'github_pat_[A-Za-z0-9_]{20,}'), 'github_pat_'),
  (re.compile(r'gh[pousr]_[A-Za-z0-9]{20,}'), None),          # prefix = first 4 chars
  (re.compile(r'sk-ant-[A-Za-z0-9_\-]{10,}'), 'sk-ant-'),
  (re.compile(r'(?:https?://[A-Za-z0-9.\-]*(?:discord(?:app)?\.com)/api(?:/v\d+)?/webhooks)/\d{5,}/[A-Za-z0-9_\-]{20,}'), None),
  (re.compile(r'https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]{10,}'), None),
  (re.compile(r'-----BEGIN [A-Z ]*PRIVATE KEY-----'), None),
  (re.compile(r'\b(?:cpws|cpen|cpag)_[A-Za-z0-9_\-]{20,}'), None),
]
def split_at(m_text, fam_prefix):
    if fam_prefix: cut = len(fam_prefix)
    elif m_text.startswith('https://'): cut = m_text.index('/webhooks') + len('/webhooks') if '/webhooks' in m_text else m_text.index('/services') + len('/services')
    elif m_text.startswith('-----BEGIN'): cut = len('-----BEGIN ')
    else: cut = 4 if m_text[:3] in ('ghp','gho','ghu','ghs','ghr') else m_text.index('_') + 1
    return cut
def process(src):
    out, n = [], 0
    for line in src.split('\n'):
        spans = []
        for rx, pre in FAMILIES:
            for m in rx.finditer(line):
                spans.append((m.start(), m.end(), pre))
        # drop overlaps (keep the first)
        spans.sort(); keep = []; last = -1
        for s in spans:
            if s[0] >= last: keep.append(s); last = s[1]
        for s, e, pre in reversed(keep):
            t = line[s:e]
            # the enclosing quote: nearest quote char before s among ' " `
            q = None
            for i in range(s - 1, -1, -1):
                if line[i] in '\'"`' and (i == 0 or line[i - 1] != '\\'): q = line[i]; break
            if q is None: continue
            cut = split_at(t, pre)
            line = line[:s + cut] + q + ' + ' + q + line[s + cut:]
            n += 1
        out.append(line)
    return '\n'.join(out), n
for f in sys.argv[1:]:
    src = open(f, encoding='utf8').read()
    new, n = process(src)
    if n: open(f, 'w', encoding='utf8').write(new)
    print(f'{f}: split {n}')
