// Fake smart-auto hub as its own process, so a blocking spawn in the test does not stall it.
// Appends "<path> <body>" per POST to $HUB_POSTS and prints its port on stdout.
import { appendFileSync } from "node:fs";

const __pp = process.ppid; setInterval(() => { if (process.ppid !== __pp) process.exit(0); }, 1000);
const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  const u = new URL(req.url);
  if (req.method === "GET") {
    if (u.pathname === "/healthz") return new Response("ok");
    if (u.pathname === "/api/smart-auto/current") return Response.json({ selection: { main: { worker: "salted-" + (u.searchParams.get("worker") ?? ""), model: "used/model", tier: "intelligence", role: "planning", reason: "fresh", state: "completed" } } });
    return Response.json({}, { status: 404 });
  }
  const body = await req.text();
  appendFileSync(process.env.HUB_POSTS!, `${u.pathname} ${body}\n`);
  if (u.pathname === "/api/smart-auto/resolve") { const r = JSON.parse(body); return Response.json({ model: "expected/" + r.tier, tier: r.tier, role: r.role ?? null, reason: "fresh", alternatives: [] }); }
  if (u.pathname === "/api/smart-auto/outcome") return Response.json({});
  return Response.json({}, { status: 404 });
} });
console.log(srv.port);
