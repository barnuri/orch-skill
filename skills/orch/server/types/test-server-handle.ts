import type { Server } from "bun";

import type { TempHome } from "../test-support/temp-home";

export interface TestServerHandle {
  server: Server<undefined>;
  url: string;
  token: string;
  home: TempHome;
  api(path: string, init?: RequestInit, auth?: boolean): Promise<Response>;
  stop(): void;
}
