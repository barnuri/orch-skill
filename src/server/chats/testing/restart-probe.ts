// A tiny server process for the restart test: opens a ChatService over the home in argv[2]; with argv[3] === "send" it
// sends one message to the chat in argv[4]. It prints one JSON line, then stays alive until it is killed.
import { hostname } from "node:os";

import { orchPaths } from "../../files/paths";
import { digestToken } from "../../http/auth";
import { ChatService } from "../service";

const [, , home, mode, chatId] = process.argv as [string, string, string, string | undefined, string | undefined];
const service = new ChatService({
  paths: orchPaths(home), bindHost: "127.0.0.1", hostname: hostname(), tokenDigest: digestToken("t"), requireToken: true,
  requireRemoteToken: true, harnesses: ["claude"], outcomes: [],
}, {});
const sent = mode === "send" && chatId !== undefined ? service.sendMessage(chatId, { content: "restart me" }) : null;
console.log(JSON.stringify({ ready: true, recovered: service.recovered, sent }));
setInterval(() => {}, 1000);
