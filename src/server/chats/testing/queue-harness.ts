import { hostname } from "node:os";

import { digestToken } from "../../http/auth";
import { orchPaths } from "../../files/paths";
import { TempHome } from "../../test-support/temp-home";
import type { ServerContext } from "../../types/server-context";
import { ChatService } from "../service";
import type { AgentEvent, AgentSession, SessionFactory } from "../sessions/types";

/** In-process fake harness and service setup for the queue tests: turns end only when the test says so. */
export const PROFILES = {
  models: { "m-a": { slug: "alpha", harnesses: ["claude"] } },
  profiles: { main: { harness: "claude", model: "m-a" } },
};

export interface FakeTurn { prompt: string; finish: () => void; fail: () => void; stopped: boolean }

/** A harness whose turns end only when the test says so: `finish()`, `fail()` or a stop. */
export class Harness {
  readonly turns: FakeTurn[] = [];
  auto = false;
  /** The next turn calls the agent's question tool, then ends: the chat waits for an answer. */
  askNext = false;
  readonly factory: SessionFactory = () => {
    const owner = this;
    let stopper: ((how: "done" | "fail" | "stop" | "detach") => void) | null = null;
    const session: AgentSession = {
      persistent: true,
      sessionId: "fake-session",
      async start() {},
      send(prompt: string): AsyncIterable<AgentEvent> {
        let resolveTurn!: (how: "done" | "fail" | "stop" | "detach") => void;
        const ended = new Promise<"done" | "fail" | "stop" | "detach">((resolve) => {
          resolveTurn = resolve;
        });
        const turn: FakeTurn = { prompt, stopped: false, finish: () => resolveTurn("done"), fail: () => resolveTurn("fail") };
        owner.turns.push(turn);
        stopper = resolveTurn;
        if (owner.auto) {
          setTimeout(() => resolveTurn("done"), 5);
        }
        const ask = owner.askNext;
        owner.askNext = false;
        return (async function* () {
          yield { type: "text-delta", text: `partial of ${prompt.split("\n")[0]}` } as AgentEvent;
          if (ask) {
            yield { type: "tool", name: "question", id: `q-${owner.turns.length}`, summary: "", input: { questions: [{ question: "Which color?", header: "Pick", options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] }] } } as AgentEvent;
          }
          const how = await ended;
          if (how === "stop") {
            turn.stopped = true;
            return;
          }
          if (how === "detach") {
            return;
          }
          if (how === "fail") {
            yield { type: "error", message: "model exploded" } as AgentEvent;
            return;
          }
          yield { type: "done", session_id: "fake-session" } as AgentEvent;
        })();
      },
      async stop() {
        stopper?.("stop");
      },
      async dispose() {
        stopper?.("detach");
      },
    };
    return session;
  };

  get prompts(): string[] {
    return this.turns.map((t) => t.prompt.split("\n")[0] as string);
  }

  current(): FakeTurn {
    return this.turns[this.turns.length - 1] as FakeTurn;
  }
}

export const cleanup: Array<() => Promise<void>> = [];
/** Call from `afterEach`: disposes every service `setup` made. */
export async function runCleanup(): Promise<void> {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
}

export function ctxFor(home: string): ServerContext {
  return {
    paths: orchPaths(home), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
    requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
  };
}

export function setup(existing?: TempHome): { service: ChatService; home: TempHome; h: Harness; chatId: string } {
  const home = existing ?? TempHome.create();
  if (existing === undefined) {
    home.write("profiles.json", JSON.stringify(PROFILES));
  }
  const h = new Harness();
  const service = new ChatService(ctxFor(home.path), { factory: h.factory });
  cleanup.push(() => service.dispose());
  const chatId = existing === undefined ? service.createChat({ harness: "claude", profile: "main" }).id : (service.store.listChats({}).items[0]?.id as string);
  return { service, home, h, chatId };
}

export async function until(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) {
      throw new Error("timed out waiting");
    }
    await Bun.sleep(5);
  }
}
