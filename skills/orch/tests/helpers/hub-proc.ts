// Loopback echo hub as its own process: a blocking spawn in the test cannot stall it (unlike fakeHub in index.ts).
export async function spawnEchoHub(delayMs = 0) {
  const src = `const d = ${delayMs};
const s = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
  let content = "", model = "";
  try { const b = await req.json(); content = b.messages?.[0]?.content ?? ""; model = b.model ?? ""; } catch {}
  if (d) await Bun.sleep(d);
  return Response.json({ choices: [{ message: { content: "echo:" + content + "|model=" + model } }] });
} });
process.stdout.write(String(s.port) + "\\n");`;
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const proc = Bun.spawn(["bun", "-e", src], { stdout: "pipe", stderr: "pipe" });
    const reader = proc.stdout.getReader();
    let text = "";
    while (!/\n/.test(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += new TextDecoder().decode(chunk.value);
    }
    const port = Number(text.replace(/\x1b\[[0-9;]*m/g, "").trim());
    if (Number.isInteger(port) && port > 0) return { port, url: `http://127.0.0.1:${port}`, stop: () => proc.kill() };
    lastErr = text.trim();
    proc.kill();
  }
  throw new Error(`spawnEchoHub: no port after 3 tries: ${lastErr}`);
}
