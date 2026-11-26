import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

@ZodObject({ description: "The run overview: repos, commits, pull requests, models, skills, nodes and handoff evidence of one run." })
export class RunOverviewDto extends ZodDto {
  @ZodField(z.string(), { description: "Run id." })
  run_id!: string;

  @ZodField(z.string(), { description: "Run title." })
  title!: string;

  @ZodField(z.string().nullable(), { description: "Run description, null when none was set." })
  description!: string | null;

  @ZodField(z.string(), { description: "Run status." })
  status!: string;

  @ZodField(z.string().nullable(), { description: "Start time, ISO 8601 UTC." })
  started!: string | null;

  @ZodField(z.string().nullable(), { description: "Finish time, ISO 8601 UTC; null while the run is live." })
  finished!: string | null;

  @ZodField(z.string(), { description: "When the overview was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.number().int(), { description: "Number of nodes in the run." })
  node_count!: number;

  @ZodField(z.array(z.object({ repo: z.string(), nodes: z.array(z.string()), commits: z.number().int() })), { description: "Repos the nodes worked in, with the nodes per repo and the commits since their start." })
  repos!: unknown[];

  @ZodField(z.array(z.object({ repo: z.string(), sha: z.string(), subject: z.string() })), { description: "Commits per repo, first 20 per repo." })
  commits!: unknown[];

  @ZodField(z.array(z.object({ repo: z.string(), url: z.string() })), { description: "Pull requests that contain a commit of the run (GitHub repos)." })
  pull_requests!: unknown[];

  @ZodField(z.array(z.string()), { description: "Repos whose pull requests could not be checked (gh unavailable)." })
  pull_requests_unavailable!: string[];

  @ZodField(z.boolean().optional(), { description: "True when the build did not wait for every GitHub lookup: pull requests may be incomplete until the next refresh." })
  pull_requests_pending?: boolean;

  @ZodField(z.array(z.object({ name: z.string(), nodes: z.number().int() })), { description: "Models used, with the node count per model." })
  models!: unknown[];

  @ZodField(z.array(z.object({ name: z.string(), nodes: z.number().int() })), { description: "Skills read by the nodes, with the node count per skill." })
  skills!: unknown[];

  @ZodField(
    z.array(z.object({ id: z.string(), label: z.string(), status: z.string(), profile: z.string(), model: z.string(), repo: z.string(), skills: z.array(z.string()) })),
    { description: "One entry per node." },
  )
  nodes!: unknown[];

  @ZodField(
    z.array(z.object({ id: z.string(), status: z.string(), state: z.enum(["yes", "empty", "missing"]), bytes: z.number().int(), file: z.string() })),
    { description: "The handoff.md of each node: yes (non-empty), empty or missing." },
  )
  handoffs!: unknown[];
}
