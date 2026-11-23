import { ZodDto, ZodField, ZodObject } from "@barnuri/zod-decorators";
import { z } from "zod";

const Score = z.number().int().min(0).max(100);

@ZodObject({ description: "One finding of a quality report." })
export class QualityFindingDto extends ZodDto {
  @ZodField(z.string(), { description: "Finding id within its report, e.g. F1." })
  id!: string;

  @ZodField(z.enum(["critical", "high", "medium", "low", "info"]), { description: "How bad the finding is." })
  severity!: "critical" | "high" | "medium" | "low" | "info";

  @ZodField(z.string(), { description: "Free-form category set by the adapter, e.g. review." })
  category!: string;

  @ZodField(z.string(), { description: "One-line statement of the finding." })
  title!: string;

  @ZodField(z.string(), { description: "Raw evidence text (quote, command output or excerpt)." })
  evidence!: string;

  @ZodField(z.string().nullable(), { description: "File the finding is about, or null." })
  file!: string | null;

  @ZodField(z.number().int().nullable(), { description: "Line in the file, or null." })
  line!: number | null;

  @ZodField(Score.nullable(), { description: "Confidence 0-100, or null when the source gives none." })
  confidence!: number | null;
}

@ZodObject({ description: "One quality report: a stage's verdict, score and findings for a node and model." })
export class QualityReportDto extends ZodDto {
  @ZodField(z.string(), { description: "Report id within its run, e.g. q1." })
  id!: string;

  @ZodField(z.string(), { description: "Run the report belongs to." })
  run_id!: string;

  @ZodField(z.string(), { description: "Node the report belongs to." })
  node_id!: string;

  @ZodField(z.enum(["implementation", "review", "final-review"]), { description: "Stage role of the node." })
  stage!: "implementation" | "review" | "final-review";

  @ZodField(z.string(), { description: "Id of the skill that produced the report." })
  skill_id!: string;

  @ZodField(z.object({ requested: z.string().nullable(), actual: z.string().nullable() }), { description: "Model requested and model that actually ran." })
  model!: { requested: string | null; actual: string | null };

  @ZodField(z.string().nullable(), { description: "Model that reviewed the work, or null." })
  reviewer_model!: string | null;

  @ZodField(z.object({ value: z.string(), score: Score.nullable() }), { description: "Verdict value and score 0-100, or null." })
  verdict!: { value: string; score: number | null };

  @ZodField(Score.nullable(), { description: "Report-level confidence 0-100, or null." })
  confidence!: number | null;

  @ZodField(z.array(QualityFindingDto.schema), { description: "Findings in source order." })
  findings!: QualityFindingDto[];

  @ZodField(z.object({ created_at: z.string(), started_at: z.string().nullable(), finished_at: z.string().nullable() }), { description: "Timestamps, ISO 8601 UTC." })
  timestamps!: { created_at: string; started_at: string | null; finished_at: string | null };

  @ZodField(z.string().nullable(), { description: "Raw source artifact path kept as evidence." })
  source_artifact!: string | null;

  @ZodField(z.string(), { description: "Adapter that mapped the source artifact." })
  adapter!: string;
}

@ZodObject({ description: "A run's quality reports, in the order they were appended." })
export class RunQualityEnvelopeDto extends ZodDto {
  @ZodField(z.string(), { description: "When the answer was built, ISO 8601 UTC." })
  generated_at!: string;

  @ZodField(z.array(QualityReportDto.schema), { description: "Every quality report of the run." })
  reports!: QualityReportDto[];
}
