import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "The optional HTTPS listener of this server. HTTP stays the default; nothing in orch uses this port by itself." })
export class ServerInfoDto extends ZodDto {
  @ZodField(z.number().int(), { description: "The HTTPS port; 0 when HTTPS is off." })
  https_port!: number;

  @ZodField(z.boolean(), { description: "True when the HTTPS listener is answering." })
  https_listening!: boolean;

  @ZodField(z.string().nullable(), { description: "Secure link for a device that needs a secure context (microphone, clipboard); null when HTTPS is not listening." })
  https_url!: string | null;

  @ZodField(z.string().nullable(), { description: "Path of the page that explains how to trust the certificate; null when no local CA is in use." })
  trust_path!: string | null;

  @ZodField(z.string().nullable(), { description: "Certificate source: tailscale, mkcert, localca, selfsigned or files." })
  cert_source!: string | null;

  @ZodField(z.string().nullable(), { description: "Certificate expiry, ISO 8601." })
  cert_expires!: string | null;

  @ZodField(z.string().nullable(), { description: "Why HTTPS is not up, or null." })
  problem!: string | null;

  @ZodField(z.boolean(), { description: "Whether the quiet secure-link hint may show (serve.json secure_link_hint)." })
  secure_link_hint!: boolean;
}
