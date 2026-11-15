#!/usr/bin/env python3
"""Contrast check for tokens.A.css / tokens.B.css. Usage: python3 contrast.py tokens.A.css"""
import re, sys
def parse(path):
    t = open(path).read(); L, D = {}, {}
    for m in re.finditer(r'--([a-z0-9-]+):\s*light-dark\((#[0-9a-fA-F]{6}),\s*(#[0-9a-fA-F]{6})\)', t):
        L[m[1]] = m[2]; D[m[1]] = m[3]
    tint = int(re.search(r'--tint:\s*(\d+)%', t)[1]) / 100
    return L, D, tint
def rgb(h): return [int(h[i:i+2], 16) for i in (1, 3, 5)]
def lum(c):
    f = lambda v: (v/255)/12.92 if v/255 <= .03928 else (((v/255)+.055)/1.055)**2.4
    r, g, b = map(f, c); return .2126*r + .7152*g + .0722*b
def cr(a, b):
    x, y = lum(a), lum(b); x, y = max(x, y), min(x, y); return (x+.05)/(y+.05)
def mix(fg, bg, a): return [round(f*a + b*(1-a)) for f, b in zip(fg, bg)]
def run(path):
    L, D, tint = parse(path); out = []; worst = 99
    for name, T in (("light", L), ("dark", D)):
        for s in ("bg", "panel", "panel2", "inset", "hover"):
            row = []
            for t in ("tx", "tx1", "tx2", "tx3", "acct"):
                c = cr(rgb(T[t]), rgb(T[s])); worst = min(worst, c); row.append(f"{t} {c:.1f}")
            out.append(f"{name:5} text on {s:6}: " + " | ".join(row))
        for st in ("status-running", "status-done", "status-error", "status-waiting", "status-skipped", "status-stale", "pu", "acc"):
            for s in ("panel", "bg"):
                tinted = mix(rgb(T[st]), rgb(T[s]), tint)
                c = cr(rgb(T[st]), tinted); worst = min(worst, c)
                out.append(f"{name:5} {st:4} text on its tint over {s:5}: {c:.1f}")
        for st in ("status-running", "status-done", "status-error", "status-waiting", "status-skipped", "status-stale"):
            for s in ("panel", "panel2", "bg", "inset"):
                c = cr(rgb(T[st]), rgb(T[s])); worst = min(worst, c)
                out.append(f"{name:5} {st:15} text/graphic on {s:6}: {c:.1f}")
        c = cr(rgb(T["onacc"]), rgb(T["acc"])); worst = min(worst, c)
        out.append(f"{name:5} onacc on acc (primary button): {c:.1f}")
        c = cr(rgb(T["focus"]), rgb(T["bg"])); out.append(f"{name:5} focus ring on bg (needs 3): {c:.1f}")
        c = cr(rgb(T["edge"]), rgb(T["panel"])); out.append(f"{name:5} edge on panel (control edge, needs 3): {c:.1f}")
    out.append(f"WORST text/status ratio: {worst:.2f} (need 4.5)")
    return "\n".join(out)
if __name__ == "__main__": print(run(sys.argv[1]))
