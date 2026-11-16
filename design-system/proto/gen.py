#!/usr/bin/env python3
"""Generates the static prototypes: <dir>-runs.html, <dir>-chats.html, <dir>-profiles[-empty|-loading|-error].html"""
P = {
 "menu": '<path d="M4 6h16M4 12h16M4 18h16"/>', "search": '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
 "plus": '<path d="M12 5v14M5 12h14"/>', "clip": '<path d="m21 11-8.5 8.5a5 5 0 0 1-7-7L14 4a3.5 3.5 0 0 1 5 5l-8.5 8.5a2 2 0 0 1-3-3L15 7"/>',
 "up": '<path d="M12 19V5M5 12l7-7 7 7"/>', "sun": '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
 "refresh": '<path d="M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M21 12a9 9 0 0 1-15 6.7L3 16M3 21v-5h5"/>',
 "x": '<path d="M18 6 6 18M6 6l12 12"/>', "down": '<path d="m6 9 6 6 6-6"/>', "check": '<path d="M20 6 9 17l-5-5"/>',
 "alert": '<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>',
 "graph": '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l3 9M16 7l-3 9"/>',
 "chat": '<path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-6A8 8 0 1 1 21 12z"/>', "user": '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
 "more": '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
 "file": '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', "term": '<path d="m5 8 4 4-4 4M12 16h7"/>',
}
def ic(n, cls=""): return f'<svg class="i {cls}" viewBox="0 0 24 24" aria-hidden="true">{P[n]}</svg>'
LOGO = ic("graph")
def mark(k): return f'<span class="mark {k}" aria-hidden="true">{ {"claude":"C","codex":"X","cursor":"R","oc":"O","local":"L"}[k] }</span>'

def head(d, title, css_extra=""):
    return f'''<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self' data:; img-src 'self' data:">
<title>{title}</title><script src="theme.js"></script><link rel="stylesheet" href="fonts-{d}.css"><link rel="stylesheet" href="../tokens.{d}.css"><link rel="stylesheet" href="comp.css"><link rel="stylesheet" href="{d.lower()}.css"></head>'''

def themebtn(): return f'<button class="btn icon ghost" aria-label="Switch theme">{ic("sun")}</button>'

# ---------- shells ----------
def shell_A(cur, inner, mobile_tabs=True):
    nav = "".join(f'<a href="{h}.html" {"aria-current=page" if n==cur else ""}>{n}</a>' for n,h in (("Runs","A-runs"),("Chats","A-chats"),("Profiles","A-profiles"),("Harnesses","#"),("Schedules","#"),("Memory","#")))
    tabs = "".join(f'<a href="{h}.html" {"aria-current=page" if n==cur else ""}>{ic(i)}<span>{n}</span></a>' for n,h,i in (("Runs","A-runs","graph"),("Chats","A-chats","chat"),("Profiles","A-profiles","user"),("More","#","more")))
    return f'''<body><a class="sr" href="#main">Skip to content</a><header class="top"><span class="brand">{LOGO}orch</span><nav class="nav" aria-label="Sections">{nav}</nav><span class="sp"></span><span class="live">Live · 2s ago</span><button class="btn icon ghost" aria-label="Refresh">{ic("refresh")}</button>{themebtn()}</header>{inner}<nav class="tabbar" aria-label="Sections">{tabs}</nav></body></html>'''

def tree_item(dot, title, sub, t, cur=False):
    return f'<a href="#" {"aria-current=page" if cur else ""}><span class="dot {dot}" role="img" aria-label="{dot}"></span><span class="t">{title}</span><time>{t}</time><small>{sub}</small></a>'
def shell_B(cur, bar_title, inner, bar_extra=""):
    nav = "".join(f'<a href="{h}.html" {"aria-current=page" if n==cur else ""}>{ic(i)}{n}</a>' for n,h,i in (("Profiles","B-profiles","user"),("Harnesses","#","term"),("Schedules","#","clock"),("Memory","#","file")))
    tree = (tree_item("run","Migrate auth service to OIDC","run · 1/4 nodes · claude-llm-hub","1m",cur=="Runs")
      + tree_item("run","Nightly dependency audit","schedule · 0/6 nodes","3m")
      + tree_item("er","Fix flaky checkout test","run · 2 errors · cursor-default","14m")
      + tree_item("ok","Release notes 4.2","run · done · 5/5 nodes","2h"))
    chats = (tree_item("run","Summarise the failing OIDC node","chat · claude-sonnet","now",cur=="Chats")
      + tree_item("ok","Review the cron parser","chat · local-qwen3.6","1h") + tree_item("wa","Compare model pricing","chat · waiting for you","3h"))
    return f'''<body><aside class="rail" aria-label="Workbench"><div class="brand">{LOGO}orch</div><div class="field">{ic("search")}Search<span class="kbd">/</span></div>
<div class="tree"><h4><span>Runs</span><span class="mono">4</span></h4>{tree}<h4><span>Chats</span><span class="mono">3</span></h4>{chats}</div>
<nav aria-label="Sections">{nav}</nav><div class="usage"><div>claude 42% · 2h 48m</div><div class="meter"><i style="width:42%"></i></div><div>local-llm 4/8 slots</div><div class="meter"><i style="width:50%"></i></div></div></aside>
<div class="main"><div class="bar"><button class="btn icon ghost menu-btn" aria-label="Open workbench">{ic("menu")}</button><h1>{bar_title}</h1><span class="sp"></span>{bar_extra}<span class="live">Live · 2s ago</span>{themebtn()}</div>{inner}</div></body></html>'''

# ---------- runs ----------
def node(k, cls, title, status_html, r1, r2, pos, sel=False):
    return f'<article class="node {cls}{" sel" if sel else ""}" style="{pos}" tabindex="0">{ "" }<h3>{mark(k)}<span>{title}</span></h3><div class="row">{status_html}</div><div class="row">{r1}</div><div class="row">{r2}</div></article>'
LOG = '<pre class="log" tabindex="0">$ bun test auth/\n  ✓ exchange returns id_token\n  ✓ refresh rotates token\n<span class="e">  ✗ logout clears session cookie</span>\n<span class="e">  ✗ nonce mismatch is rejected</span>\n<span class="e">  ✗ expired state returns 400</span>\n3 failed · 12 passed\nexit 1</pre>'
def runs_A():
    nodes = (node("claude","ok","Plan the migration",'<span class="st ok">Done</span><b>10s</b>',"planning","claude-llm-hub","left:20px;top:110px")
     + node("claude","run","Implement token exchange",'<span class="st run">Running</span><b>1m 20s</b>',"implementation","claude-llm-hub","left:300px;top:48px")
     + node("local","er","Write integration tests",'<span class="st er">Error</span><b>20s</b>',"validation · attempt 1/5","local-llm-fast","left:300px;top:192px",True)
     + node("cursor","wait","Review and fix",'<span class="st">Waiting</span><b>—</b>',"validation","cursor-default","left:580px;top:120px"))
    svg = '<svg class="edges" viewBox="0 0 820 330" aria-hidden="true"><path class="ok" d="M240 150 C275 150 265 88 300 88"/><path class="ok" d="M240 150 C275 150 265 232 300 232"/><path class="on" d="M520 88 C555 88 545 160 580 160"/><path d="M520 232 C555 232 545 160 580 160"/></svg>'
    body = f'''<main id="main" class="page"><div class="head"><h1>Migrate auth service to OIDC</h1><span class="st run">Running</span><a class="tx2" href="A-runs.html">All runs</a><span class="grow"></span><button class="btn primary">Retry failed nodes</button><button class="btn danger">Stop run</button></div>
<div class="strip"><div><small>Run</small><b>…121436-3418</b></div><div><small>Started</small><b>14:14:36</b></div><div><small>Elapsed</small><b>1m 40s</b></div><div><small>Nodes</small><b>1 of 4 done</b></div><div><small>Running</small><b style="color:var(--acct)">1</b></div><div><small>Error</small><b style="color:var(--er)">1</b></div><div><small>Waiting</small><b>1</b></div></div>
<section class="panel" aria-label="Run graph"><div class="tools"><button class="btn sm">Follow live</button><div class="seg" role="group" aria-label="Zoom"><button aria-pressed="false">−</button><button aria-pressed="true">Fit</button><button aria-pressed="false">+</button></div><span class="sp"></span><span class="tx3" style="font-size:var(--fs-meta)">3 stages · drag to pan</span></div>
<div class="canvas" tabindex="0"><div class="in"><span class="stage" style="left:20px">Stage 1 · plan</span><span class="stage" style="left:300px">Stage 2 · 2 in parallel</span><span class="stage" style="left:580px">Stage 3 · review</span>{svg}{nodes}</div></div></section>
<section class="panel detail"><div><h2>Write integration tests <span class="st er" style="margin-left:8px">Error</span></h2><div class="tx2" style="font-size:var(--fs-meta)">Failed after 20s · local-llm-fast · exit 1. Retry the node after fixing the failing logout test.</div><div style="display:flex;gap:8px;margin-top:4px"><button class="btn sm primary">Retry node</button><button class="btn sm">Open session</button></div></div><div><h2>Log tail</h2>{LOG}</div></section></main>'''
    return head("A","orch — run") + shell_A("Runs", body)
def runs_B():
    nodes = (node("claude","ok","Plan the migration",'<span class="st ok">Done</span><b>10s</b>',"planning","claude-llm-hub","left:8px;top:120px")
     + node("claude","run","Implement token exchange",'<span class="st run">Running</span><b>1m 20s</b>',"implementation","claude-llm-hub","left:256px;top:52px")
     + node("local","er","Write integration tests",'<span class="st er">Error</span><b>20s</b>',"validation","local-llm-fast","left:256px;top:204px",True)
     + node("cursor","wait","Review and fix",'<span class="st">Waiting</span><b>—</b>',"validation","cursor-default","left:504px;top:128px"))
    svg = '<svg class="edges" viewBox="0 0 720 340" aria-hidden="true"><path class="ok" d="M204 170 C230 170 230 102 256 102"/><path class="ok" d="M204 170 C230 170 230 254 256 254"/><path class="on" d="M452 102 C478 102 478 178 504 178"/><path d="M452 254 C478 254 478 178 504 178"/></svg>'
    inner = f'''<div class="macts"><button class="btn">Stop run</button><button class="btn primary">Retry failed nodes</button></div><div class="scroll"><div class="runbody"><div class="stage-area"><div class="facts"><span>run <b>…121436-3418</b></span><span>started <b>14:14:36</b></span><span>elapsed <b>1m 40s</b></span><span>nodes <b>1/4</b></span><span class="st run">1 running</span><span class="st er">1 error</span></div>
<div class="canvas" tabindex="0"><div class="in"><span class="stage" style="left:8px">stage 1</span><span class="stage" style="left:256px">stage 2 · parallel</span><span class="stage" style="left:504px">stage 3</span>{svg}{nodes}</div></div></div>
<aside class="insp" aria-label="Node inspector"><h2>{mark("local")}Write integration tests</h2><span class="st er" style="justify-self:start">Error · exit 1</span><dl><dt>profile</dt><dd>local-llm-fast</dd><dt>model</dt><dd>qwen3.6-35b</dd><dt>attempt</dt><dd>1 / 5</dd><dt>elapsed</dt><dd>20s</dd><dt>stage</dt><dd>2 of 3</dd></dl>{LOG}<div style="display:flex;gap:8px"><button class="btn primary">Retry node</button><button class="btn">Session</button></div></aside></div></div>'''
    extra = '<button class="btn">Stop run</button><button class="btn primary">Retry failed nodes</button>'
    return head("B","orch — run") + shell_B("Runs","Migrate auth service to OIDC", inner, extra)

# ---------- chats ----------
def chip(txt, k=None, x=False): return f'<span class="chip">{mark(k) if k else ""}{txt}{ic("down") if not x else ic("x","x")}</span>'
def convo(d):
    if d == "A":
        return '''<div class="m-user">Summarise the failing node in the OIDC run and suggest a fix</div><div class="m-bot"><div class="tool">{t}<b>Read</b> runs/…121436-3418/state.json<span class="d">0.2s</span></div><p>The <span class="mono">tests</span> node exited 1 after 20 seconds. Three tests failed, all in the logout path: the session cookie is not cleared, the nonce check does not reject a replay, and an expired <span class="mono">state</span> returns 200 instead of 400.</p><p>Start with the cookie: the logout handler never calls <span class="mono">clearSession()</span> after the token revoke.</p><div class="foot"><span>done</span><span>claude-sonnet</span><span>4.1s</span><span>2,914 in / 388 out</span><span>$0.01</span></div></div>'''.replace("{t}", ic("file"))
    return '''<div class="m-user">Summarise the failing node in the OIDC run and suggest a fix</div><div class="m-bot"><div class="tool">Read <b>state.json</b> <span class="mono tx3">runs/…121436-3418</span><span class="d">0.2s</span></div><div class="tool">Run <b>bun test auth/</b><span class="d">3 failed · 5.4s</span></div><p>The <span class="mono">tests</span> node exited 1 after 20 seconds. Three tests failed, all in the logout path: the session cookie is not cleared, a replayed nonce is accepted, and an expired <span class="mono">state</span> returns 200 instead of 400.</p><div class="worker">{m}<b>fix-logout</b><span class="st run">Running</span><small>Started worker on local-llm-fast · call clearSession() after revoke</small></div><div class="foot"><span>done</span><span>claude-sonnet</span><span>4.1s</span><span>2,914 in / 388 out</span><span>$0.01</span></div></div>'''.replace("{m}", mark("local"))
def composer(d):
    attach = '<span class="chip">' + ic("file") + 'state.json<span class="mono tx3">38 KB</span>' + ic("x","x") + '</span>'
    picks = chip("Claude Code","claude") + chip("claude-default") + chip("claude-sonnet")
    return f'''<div class="composer"><div class="cbox"><div style="display:flex;gap:8px;flex-wrap:wrap">{attach}</div><div class="ta">Message, or paste a file  ·  <span class="kbd">/</span> commands</div><div class="crow"><button class="btn icon ghost" aria-label="Attach files">{ic("clip")}</button><div class="picks" role="group" aria-label="Harness, profile and model">{picks}</div><button class="btn primary icon send" aria-label="Send">{ic("up")}</button></div></div></div>'''
def chats_A():
    th = lambda t,s,cur=False,dot="ok": f'<a class="th" href="#" {"aria-current=page" if cur else ""}><b>{t}</b><small><span class="st {dot}" style="height:18px;padding:0 6px">{ {"ok":"done","run":"live","wa":"waiting"}[dot] }</span>{s}</small></a>'
    threads = f'''<aside class="threads"><div class="tools"><button class="btn primary" style="flex:1">New chat</button><button class="btn">Project</button></div><div style="padding:0 12px 8px"><div class="field">{ic("search")}Search all history<span class="kbd">Ctrl K</span></div></div><div class="tl"><h4><span>No project</span><span class="mono">3</span></h4>{th("Summarise the failing OIDC node","claude · now",True,"run")}{th("Review the cron parser","local-qwen · 1h")}{th("Compare model pricing","claude · 3h",False,"wa")}<h4><span>orch-skill</span><span class="mono">2</span></h4>{th("Refactor dispatch.ts start","cursor · 1d")}{th("Why does prune keep a run?","claude · 2d")}</div></aside>'''
    body = f'''<main id="main" class="chats">{threads}<section class="conv"><div class="ch"><button class="btn icon ghost" aria-label="Threads" style="display:none">{ic("menu")}</button><h1>Summarise the failing node in the OIDC run and suggest a fix</h1><button class="btn">No project{ic("down")}</button><button class="btn">Archive</button></div><div class="msgs">{convo("A")}</div>{composer("A")}</section></main>'''
    return head("A","orch — chats") + shell_A("Chats", body)
def chats_B():
    pop = f'''<div class="pop" role="listbox" aria-label="Model"><div class="field">{ic("search")}Search models</div><h5>Pinned</h5><div class="o" aria-selected="true">{mark("claude")}claude-sonnet<small>claude</small>{ic("check")}</div><div class="o">{mark("claude")}claude-opus<small>claude</small><span></span></div><h5>Local</h5><div class="o">{mark("local")}qwen3.6-35b<small>llm-hub</small><span></span></div><div class="o">{mark("codex")}gpt-5.1<small>codex</small><span></span></div></div>'''
    inner = f'<div class="conv"><div class="msgs">{convo("B")}</div>{pop}{composer("B")}</div>'
    return head("B","orch — chats") + shell_B("Chats","Summarise the failing node in the OIDC run", inner, '<button class="btn">Archive</button>')

# ---------- profiles ----------
ROWS = [("claude","claude-default","claude-sonnet","ok","Passed","2m ago",True,True),("claude","claude-planner","claude-opus-1m","ok","Passed","1h ago",True,False),
 ("claude","claude-llm-hub","local-qwen3.6-35b","ok","Passed","4m ago",True,False),("cursor","cursor-default","cursor-auto","er","Failed","12m ago",True,False),
 ("codex","codex-default","gpt-5.1","ok","Passed","9m ago",True,False),("oc","opencode-default","hub/smart-auto-balance","","Not tested","never",False,False),
 ("local","local-llm-fast","qwen3.6-35b-a3b","wa","Slow · 41s","30m ago",True,False)]
def prow(d, r):
    k,n,m,s,sl,t,on,dflt = r
    st = f'<span class="st {s}">{sl}</span>'
    tog = f'<button class="tog" role="switch" aria-checked="{str(on).lower()}" aria-label="Enable {n}"></button>'
    dd = ' <span class="st run" style="margin-left:6px">default</span>' if dflt else ""
    cls = "r" + ("" if on else " off") + (f" {s}" if s in ("ok","er") else "")
    spine = "<i></i>" if d=="B" else ""
    return f'<div class="{cls}">{spine}{mark(k)}<b>{n}{dd}</b><span class="mdl">{m}</span>{st}<span class="tx3 mono" style="font-size:var(--fs-meta)">{t}</span>{tog}</div>'
def profiles(d, state="list"):
    hd = '<div class="r hd">' + ("<i></i>" if d=="B" else "") + '<span></span><span>Profile</span><span>Model</span><span>Sanity</span><span>Last used</span><span></span></div>'
    if state == "list": inner = hd + "".join(prow(d, r) for r in ROWS)
    elif state == "loading": inner = hd + "".join(f'<div class="r" style="min-height:{52 if d=="A" else 48}px">' + ("<i></i>" if d=="B" else "") + '<span class="sk" style="width:18px;height:18px"></span><span class="sk" style="height:12px;width:70%"></span><span class="sk" style="height:12px;width:55%"></span><span class="sk" style="height:20px;width:80px"></span><span></span><span></span></div>' for _ in range(6))
    elif state == "empty": inner = f'<div class="empty">{ic("user")}<b>No profiles yet</b><span>A profile pairs a harness with a model. Add one, or import the starter set.</span><div style="display:flex;gap:8px"><button class="btn primary">New profile</button><button class="btn">Import starter set</button></div></div>'
    else: inner = f'<div style="padding:16px"><div class="errbox" role="alert">{ic("alert")}<span><b>Could not load profiles.</b> The server did not answer in 5s. Check that orch serve is running.</span><button class="btn sm">Retry</button></div></div>'
    cnt = {"list":"7 profiles · default claude-default","loading":"Loading profiles…","empty":"0 profiles","error":"Profiles unavailable"}[state]
    top = f'''<div class="head"><h1>Profiles</h1><span class="tx2">{cnt}</span><span class="grow"></span><div class="seg" role="group" aria-label="Filter"><button aria-pressed="true">All</button><button aria-pressed="false">Enabled</button><button aria-pressed="false">Failing</button></div><button class="btn">Sanity test all</button><button class="btn primary">New profile</button></div>'''
    body = f'<main id="main" class="page">{top}<section class="panel ledger" aria-label="Profiles">{inner}</section></main>'
    if d == "A": return head("A","orch — profiles") + shell_A("Profiles", body)
    return head("B","orch — profiles") + shell_B("Profiles","Profiles", f'<div class="scroll">{body}</div>')

FONTS = {
 "A": [("IBM Plex Sans",400,"ibm-plex-sans-latin-400-normal"),("IBM Plex Sans",500,"ibm-plex-sans-latin-500-normal"),("IBM Plex Sans",600,"ibm-plex-sans-latin-600-normal"),("IBM Plex Mono",400,"ibm-plex-mono-latin-400-normal"),("IBM Plex Mono",600,"ibm-plex-mono-latin-600-normal")],
 "B": [("Geist",400,"geist-latin-400-normal"),("Geist",500,"geist-latin-500-normal"),("Geist",600,"geist-latin-600-normal"),("Geist Mono",400,"geist-mono-latin-400-normal"),("Geist Mono",500,"geist-mono-latin-500-normal"),("Geist Mono",600,"geist-mono-latin-600-normal")]}
for d, fl in FONTS.items():
    open(f"fonts-{d}.css","w").write("".join(f'@font-face {{ font-family: "{f}"; font-weight: {w}; font-style: normal; font-display: swap; src: url("../fonts/{u}.woff2") format("woff2"); }}\n' for f,w,u in fl))
out = {"A-runs": runs_A(), "B-runs": runs_B(), "A-chats": chats_A(), "B-chats": chats_B()}
for d in "AB":
    for s in ("list","empty","loading","error"): out[f"{d}-profiles" + ("" if s=="list" else "-"+s)] = profiles(d, s)
import re
U = {}
def unstyle(h):
    def f(m):
        css = m.group(1)
        U.setdefault(css, len(U) + 1)
        return f'data-u="{U[css]}"'
    return re.sub(r'style="([^"]*)"', f, h)
for k, v in out.items():
    v = unstyle(v).replace('<link rel="stylesheet" href="a.css">','<link rel="stylesheet" href="a.css"><link rel="stylesheet" href="u.css">').replace('<link rel="stylesheet" href="b.css">','<link rel="stylesheet" href="b.css"><link rel="stylesheet" href="u.css">')
    open(k + ".html", "w").write(v)
open("u.css", "w").write("/* generated from the former inline styles: CSP style-src self forbids style attributes */\n" + "".join(f'[data-u="{n}"][data-u] {{ {c} }}\n' for c, n in U.items()))
print(len(out), "files")
