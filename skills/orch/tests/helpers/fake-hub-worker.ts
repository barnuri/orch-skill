// Loopback echo hub in its own thread (see fakeHub in index.ts): the test thread may block while an orch call runs.
declare const self: any;
self.onmessage = (e: any) => {
  const { sab, delayMs } = e.data;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      let content = "", model = "";
      try { const b: any = await req.json(); content = b.messages?.[0]?.content ?? ""; model = b.model ?? ""; } catch {}
      if (delayMs) await Bun.sleep(delayMs);
      return Response.json({ choices: [{ message: { content: `echo:${content}|model=${model}` } }] });
    },
  });
  const ia = new Int32Array(sab);
  Atomics.store(ia, 0, server.port);
  Atomics.notify(ia, 0);
  self.onmessage = () => { server.stop(true); };
};
