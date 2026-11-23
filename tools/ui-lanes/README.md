# orch UI lanes

Two isolated lanes for the orch web UI. Neither lane reads or writes the live orch home
(`~/.harness-orch`) or the live service on port 6724.

## Lanes

| Lane | Runs | Backend | Home | Port |
|---|---|---|---|---|
| Mock (fast) | Vite dev server over `src/web` | in-memory `/api` (`mock/mock-api.ts`, fixtures in `mock/fixtures.ts`) | none | 5174 (`ORCH_MOCK_PORT`) |
| Integration | Docker Compose: server + UI, Playwright | real `dispatch.ts serve` in a container | temp copy seeded per run, bind-mounted | random (`ORCH_LANE_PORT`) |

## Commands

Run from `tools/ui-lanes/`. Install once: `npm ci`.

```bash
bun mock/serve.ts                          # mock dev server on 5174 (Ctrl-C to stop)
bun run test:mock                          # Playwright, mock lane (starts its own server)
bun test tests/isolation                   # static and runtime proofs, both lanes
bun run test:lanes                         # isolation + mock lane
bun integration/run.ts                     # integration lane: seed, compose up, Playwright, proof, down
bun integration/run.ts --keep              # same, but leave the stack up for inspection
```

The integration lane needs Docker, and `bun install` run once at the repo root (the container
mounts `node_modules`).

## How isolation is proven

- `tests/isolation/isolation.test.ts`: static. No lane file contains a literal path to the live home
  or the live port 6724. The compose file bind-mounts only `ORCH_LANE_HOME` and publishes only `ORCH_LANE_PORT`.
- `tests/isolation/runtime-proof.test.ts`: runtime. The mock server, the seed, and the compose config run with
  `HOME` set to a sandbox that holds a `.harness-orch` sentinel. The sentinel file is mode 000 (any read fails
  with `EACCES`), and the sentinel tree fingerprint (names, sizes, mtimes) must not change.
- `integration/run.ts`: same sentinel check on the real run, then exits non-zero on any change.

What the proof does not cover: the live home itself is never fingerprinted, because the live service writes
there while it runs. The guarantee is that no lane process has the live path in its environment and that
the sentinel stays untouched.

## Environment variables

- `ORCH_MOCK_PORT`: mock lane port. Refuses 6724.
- `ORCH_LANE_PORT`: integration host port. Refuses 6724. Unset means a free port is picked.
- `ORCH_LANE_URL`: set by `run.ts` for the Playwright integration specs.

## Notes

- Playwright navigates with `waitUntil: "commit"`. The app holds a live feed, so `load` never settles.
- The first mock request after a Vite cache change compiles dependencies. The expect timeout is 20 s for that.
- The integration lane's seeded run (`lane-run`) is picked up by the server watchdog, which may finish it. The specs check the title, not the status.
