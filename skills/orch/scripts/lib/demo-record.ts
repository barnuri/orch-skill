/**
 * Records the dashboard as a sequence of PNG frames, for `scripts/demo-gif.sh` to hand to
 * ffmpeg. Entry point, not a library — the storyboard lives here because it is choreography,
 * while the protocol lives in CdpSession.
 *
 * The storyboard advances the demo run between shots (via `dispatch.sh demo advance`) rather
 * than letting a separate loop race it, so the recording is deterministic: advance, settle,
 * capture.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CdpSession } from "./cdp-session";

interface RecorderOptions {
  readonly port: number;
  readonly baseUrl: string;
  readonly runId: string;
  readonly outDir: string;
  readonly dispatch: string;
  readonly home: string;
}

interface Beat {
  readonly note: string;
  /** Hash route to show before this beat's frames. Omitted keeps the current view. */
  readonly route?: string;
  /** Step the demo run forward first, so the graph visibly changes. */
  readonly advance?: boolean;
  /** Click the first node whose accessible label starts with this text. */
  readonly clickNode?: string;
  /** Click a button by its visible text — used for the graph's "Fit" control. */
  readonly clickButton?: string;
  /** How many frames to hold this beat for — the GIF's dwell time. */
  readonly frames: number;
}

const ATTACH_TIMEOUT_MS: number = 15_000;
const SETTLE_MS: number = 700;
const FRAME_MS: number = 260;
const VIEWPORT_WIDTH: number = 1280;
const VIEWPORT_HEIGHT: number = 760;

function storyboard(runId: string): readonly Beat[] {
  return [
    { note: "the runs list", route: "#/", frames: 5 },
    { note: "open the live run", route: `#/run/${runId}`, frames: 3 },
    { note: "fit the graph", clickButton: "Fit", frames: 4 },
    { note: "a node finishes", advance: true, frames: 4 },
    { note: "the next node starts", advance: true, frames: 4 },
    { note: "inspect a node's whole session", clickNode: "Write the schema", frames: 8 },
    { note: "another node's session", clickNode: "Survey the existing", frames: 5 },
    { note: "profiles and their harnesses", route: "#/profiles", frames: 6 },
    { note: "harness detection", route: "#/harnesses", frames: 6 },
  ];
}

class DemoRecorder {
  private readonly options: RecorderOptions;
  private frameIndex: number = 0;

  constructor(options: RecorderOptions) {
    this.options = options;
  }

  private advance(): void {
    const result = Bun.spawnSync(["bash", this.options.dispatch, "demo", "advance"], {
      env: { ...process.env, HARNESS_ORCH_HOME: this.options.home },
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) {
      process.stderr.write(`demo advance failed: ${new TextDecoder().decode(result.stderr)}\n`);
    }
  }

  private async capture(session: CdpSession): Promise<void> {
    const png = await session.screenshot();
    const name = `frame-${String(this.frameIndex).padStart(4, "0")}.png`;
    writeFileSync(join(this.options.outDir, name), png);
    this.frameIndex++;
  }

  // Nodes are SVG groups, so there is no CSS selector for their text — match the accessible
  // label the graph already sets, which is also what a screen reader would read out.
  private async clickNode(session: CdpSession, labelPrefix: string): Promise<void> {
    const clicked = await session.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('.node.task-node')];
      const target = nodes.find((n) => (n.getAttribute('aria-label') || '').startsWith(${JSON.stringify(labelPrefix)}));
      if (!target) { return false; }
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      return true;
    })()`);
    if (clicked !== true) {
      process.stderr.write(`no node labelled ${labelPrefix}\n`);
    }
  }

  private async clickButton(session: CdpSession, label: string): Promise<void> {
    const clicked = await session.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => (b.textContent || '').trim() === ${JSON.stringify(label)});
      if (!button) { return false; }
      button.click();
      return true;
    })()`);
    if (clicked !== true) {
      process.stderr.write(`no button labelled ${label}\n`);
    }
  }

  async run(): Promise<void> {
    mkdirSync(this.options.outDir, { recursive: true });
    const session = await CdpSession.attach(this.options.port, ATTACH_TIMEOUT_MS);
    await session.setViewport(VIEWPORT_WIDTH, VIEWPORT_HEIGHT);
    await session.navigate(`${this.options.baseUrl}/`);
    await Bun.sleep(SETTLE_MS * 2);

    for (const beat of storyboard(this.options.runId)) {
      if (beat.advance === true) {
        this.advance();
      }
      if (beat.route !== undefined) {
        await session.evaluate(`location.hash = ${JSON.stringify(beat.route)}`);
      }
      if (beat.clickButton !== undefined) {
        await this.clickButton(session, beat.clickButton);
      }
      if (beat.clickNode !== undefined) {
        await this.clickNode(session, beat.clickNode);
      }
      await Bun.sleep(SETTLE_MS);
      for (let shot = 0; shot < beat.frames; shot++) {
        await this.capture(session);
        await Bun.sleep(FRAME_MS);
      }
      process.stderr.write(`recorded: ${beat.note}\n`);
    }
    session.close();
    process.stdout.write(`${this.frameIndex}\n`);
  }
}

function required(name: string): string {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (found === undefined) {
    throw new Error(`missing ${prefix}<value>`);
  }
  return found.slice(prefix.length);
}

await new DemoRecorder({
  port: Number(required("port")),
  baseUrl: required("base-url"),
  runId: required("run"),
  outDir: required("out"),
  dispatch: required("dispatch"),
  home: required("home"),
}).run();
