import { z } from "zod";

// zod probes for JIT support with `new Function("")` the first time an object schema parses.
// `script-src 'self'` refuses it and WebKit reports a CSP violation on every page load. The
// policy forbids eval anyway, so turn the probe off. main.tsx imports this module first, so it
// runs before any module that parses at import time.
z.config({ jitless: true });
