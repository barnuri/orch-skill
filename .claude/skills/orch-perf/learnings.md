
## 2026-11-16T14:30 run 20261115-114006-0bff
<!-- metrics {"nodes":200,"done":181,"errors":4,"retried":23,"no_handoff_done":145,"median_node_s":745,"median_queue_s":15,"asks":11,"median_ask_latency_s":702,"cost_usd":80.48} -->
- numbers: nodes=200, done=181, errors=4, retried=23, no_handoff_done=145, median_node_s=745, median_queue_s=15, asks=11, median_ask_latency_s=702, cost_usd=80.48
- cost by profile: opencode-smart-auto n=169 $77.39; opencode-opus-plan n=1 $0.54; opencode-haiku-exec n=29 $2.56; opencode-sonnet-verify n=1 $0.00
- no metric worse than the previous block
- problem: 145 node(s) done without handoff (agents ending early)
- problem: 4 node(s) in error: bun-p2-dispatch: exit=unknown (job process gone without an exit cod; bun-p5-serve: stuck starting; colorized-output: stuck starting; coordinator-failover: stuck starting
- problem: median ask latency 702 s (coordinator slow to answer)
- load average at measure time: n/a
