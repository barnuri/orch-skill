---
name: verify
description: (BN) Fast, repeatable verification of orch-skill work with saved scripts: the dashboard API, the run page in a real browser (playwright-cli), herdr panes, and the herdr-web pad. Use after any change to src/, the orch skill or a herdr mod, before saying something works, and when a UI claim must be proven with output or a screenshot. Triggers: "verify", "check it in the browser", "does the run page show", "is the service up", "prove it works".
---

# verify

Run the saved scripts instead of retyping browser steps. Each prints one `PASS` or `FAIL` line per check and exits non-zero on a fail. Show their output as the evidence.

The skill and its scripts live in the orch-skill repo: `.claude/skills/verify/SKILL.md` (a repo skill, not part of the plugin) and `scripts/verify` (`/Users/barnu/sandbox/private/orch-skill/scripts/verify`, call it `$V`), so they change with the code they check. They need `jq`, `curl`, `playwright-cli` and `herdr` on PATH.

## Fast order (about 30 seconds)

1. `$V/check-api.sh` - service up, `/api/build` `stale:false`, watchdog on, run counts.
2. `$V/check-run-page.sh <run-id> [text ...]` - opens the run page headless, waits for cards, fails if any given text is missing, saves a screenshot.
3. `$V/check-herdr.sh` - orch herdr instance panes and agent states (read only).
4. `$V/check-herdr-web.sh [url]` - herdr-web pad answers and renders.

Run 1 first. If the service is stale, restart it (`bash scripts/service.sh restart` in the orch-skill repo) before the browser checks, or the page shows old code.

## Rules

- Prove UI claims with `check-run-page.sh` text checks plus the screenshot path, not with unit tests alone.
- A card check passes only when the value text is on the page (model, role, tier, usage, cost), not when the label is.
- Never touch the user's own herdr (pid in `pgrep -x herdr`, `HOME=~`). The orch instance uses `HOME=~/.harness-orch/herdr/home`.
- Use one named browser session (`-s=verify`). The scripts close it at the end.
- Save new browser steps as a script in `$V` the first time you need them. Keep each script under 40 lines.

## Maintaining this skill

After each verification that needed new steps, add or update a script in `$V`, commit it in the orch-skill repo, and add one line in this file. Re-run all four scripts when a UI route, API path or port changes, and fix the script, not the check.
