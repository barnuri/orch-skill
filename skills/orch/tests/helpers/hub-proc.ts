// Loopback echo hub as its own process: a blocking spawn in the test cannot stall it (unlike fakeHub in index.ts).
export async function spawnEchoHub(delayMs = 0) {
  const src = `const d = ${delayMs};
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  let content = "", model = "";
  try { const b = await req.json(); content = b.messages?.[0]?.content ?? ""; model = b.model ?? ""; } catch {}
  if (d) await Bun.sleep(d);
  return Response.json({ choices: [{ message: { content: "echo:" + content + "|model=" + model } }] });
} });
console.log(s.port);`;
  const proc = Bun.spawn(["bun", "-e", src], { stdout: "pipe" });
  const first = await proc.stdout.getReader().read();
  const port = Number(new TextDecoder().decode(first.value).trim());
  return { port, url: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
}
