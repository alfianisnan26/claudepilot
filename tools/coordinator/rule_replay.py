#!/usr/bin/env python3
"""Replay the Bash commands agents really ran against proposed deny rules, before they land (D-60).

A deny rule with a `*` in the middle also matches branch names, paths and commit text (T-708: `git -C * config*` refused commit
messages). This shows every real command a NEW deny line would refuse, so a tightening is checked against the work it may break.

  rule_replay.py --settings <.claude/settings.json> --add <file: one rule per line> --corpus <jsonl: {"session","at","command"}>
  rule_replay.py --self-test

Matching follows Claude Code's Bash rules: `Bash(x:*)` is a prefix, `*` matches any run of characters (spaces too), anything else is
exact; a compound command is checked part by part (&&, ||, ;, |, newlines) and as a whole. Approximate on purpose (quotes are not
parsed), so a hit is a reason to look, and no hit is not a proof.
"""
import argparse
import json
import re
import sys


def rule_body(rule):
    m = re.fullmatch(r"Bash\((.*)\)", rule.strip())
    return m.group(1) if m else None


def matcher(body):
    if body.endswith(":*"):
        prefix = body[:-2]
        return lambda cmd: cmd.startswith(prefix)
    rx = re.compile("^" + ".*".join(re.escape(p) for p in body.split("*")) + "$", re.S)
    return lambda cmd: bool(rx.match(cmd))


def parts(command):
    out = [command.strip()]
    for p in re.split(r"\s*(?:&&|\|\||;|\||\n)\s*", command):
        p = p.strip()
        if p and p not in out:
            out.append(p)
    return out


def self_test():
    """The cases that bit before (T-708) and the merge-strategy forms of T-511."""
    m = lambda rule, cmd: any(matcher(rule_body(rule))(p) for p in parts(cmd))
    assert m("Bash(git -C * config*)", 'git -C /w commit -m "set config default"'), "T-708: a mid * matches commit text"
    assert not m("Bash(git -C * merge -s*)", "git -C /w merge origin/ticket/T-755-io-leak-sweep")
    assert not m("Bash(git -C * merge * -s*)", 'git -C /w merge origin/stg -m "Merge into ticket/T-621-org-seat"')
    assert m("Bash(git -C * merge -s*)", "git -C /w merge -sours origin/stg")
    assert m("Bash(git -C * merge * -X*)", "git -C /w merge --no-ff -Xtheirs origin/stg")
    assert m("Bash(npm run deploy*)", "cd x && npm run deploy:stg"), "a compound command is checked part by part"
    print("self-test ok")


def main():
    if sys.argv[1:] == ["--self-test"]:
        return self_test()
    ap = argparse.ArgumentParser()
    ap.add_argument("--settings", required=True)
    ap.add_argument("--add", required=True, help="proposed deny rules, one per line")
    ap.add_argument("--corpus", required=True)
    a = ap.parse_args()
    current = json.load(open(a.settings)).get("permissions", {}).get("deny", [])
    cur = [matcher(b) for b in (rule_body(r) for r in current) if b is not None]
    new = []
    for line in open(a.add):
        line = line.strip()
        if line and not line.startswith("#") and rule_body(line) is not None and line not in current:
            new.append((line, matcher(rule_body(line))))
    hits, seen = {}, 0
    for raw in open(a.corpus):
        try:
            row = json.loads(raw)
        except ValueError:
            continue
        cmd = row.get("command") or ""
        seen += 1
        ps = parts(cmd)
        if any(m(p) for m in cur for p in ps):
            continue  # already refused today: not a change
        for rule, m in new:
            if any(m(p) for p in ps):
                hits.setdefault(rule, []).append(row)
    print(f"commands replayed: {seen}; new deny rules: {len(new)}; rules that would refuse a real command: {len(hits)}")
    for rule, rows in sorted(hits.items(), key=lambda kv: -len(kv[1])):
        print(f"\n{rule}  refuses {len(rows)}")
        for r in rows[:4]:
            print(f"  {r.get('session', '')[:8]} {r.get('at', '')[11:19]}  {r['command'][:180]!r}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main())
