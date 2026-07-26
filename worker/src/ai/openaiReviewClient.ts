import { jobMatchEvidenceSchema, jobMatchEvidenceJsonSchema, type JobMatchInput, type JobMatchProvider } from "./matchSchema";
import { buildJobMatchUserPrompt, jobMatchSystemPrompt } from "./prompt";

type OpenAiReviewConfig = {
  apiKey: string;
  model: string;
  reasoningEffort: "low" | "medium" | "high";
  requestTimeoutMs: number;
};

type ResponsesApiResponse = {
  output_text?: string;
  output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  error?: { message?: string };
};

function responseText(response: ResponsesApiResponse) {
  if (response.output_text) return response.output_text;
  for (const output of response.output ?? []) {
    for (const content of output.content ?? []) {
      if (content.type === "output_text" && content.text) return content.text;
    }
  }
  return null;
}

export class OpenAiJobMatchProvider implements JobMatchProvider {
  readonly providerName = "openai" as const;
  readonly model: string;

  constructor(private readonly config: OpenAiReviewConfig) {
    this.model = config.model;
  }

  async assess(input: JobMatchInput, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.config.apiKey}`,
        "content-type": "application/json",
      },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model: this.model,
        reasoning: { effort: this.config.reasoningEffort },
        input: [
          { role: "system", content: [{ type: "input_text", text: jobMatchSystemPrompt }] },
          { role: "user", content: [{ type: "input_text", text: buildJobMatchUserPrompt(input) }] },
        ],
        text: {
          format: {
            type: "json_schema",
            name: "job_match_evidence",
            strict: true,
            schema: jobMatchEvidenceJsonSchema,
          },
        },
      }),
    });
    const body = (await response.json().catch(() => ({}))) as ResponsesApiResponse;
    if (!response.ok) throw new Error(`Remote review failed (${response.status}): ${body.error?.message ?? "unknown error"}`);
    const text = responseText(body);
    if (!text) throw new Error("Remote review returned no structured text.");
    try {
      return jobMatchEvidenceSchema.parse(JSON.parse(text));
    } catch {
      throw new Error("Remote review returned invalid structured JSON.");
    }
  }
}
