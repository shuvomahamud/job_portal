import { jobMatchEvidenceSchema, jobMatchEvidenceJsonSchema, type JobMatchInput, type JobMatchProvider } from "./matchSchema";
import { buildJobMatchUserPrompt, jobMatchSystemPrompt } from "./prompt";

type OllamaConfig = {
  baseUrl: string;
  allowedRemoteHosts?: string[];
  model: string;
  requestTimeoutMs: number;
  keepAlive: string;
};

type OllamaResponse = {
  message?: { content?: string };
  error?: string;
};

export function validateOllamaBaseUrl(baseUrl: string, allowedRemoteHosts: string[] = []) {
  const url = new URL(baseUrl);
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  const allowedHosts = new Set(allowedRemoteHosts.map((host) => host.trim().toLowerCase()).filter(Boolean));
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("OLLAMA_BASE_URL must use HTTP or HTTPS.");
  }
  if (url.username || url.password) {
    throw new Error("OLLAMA_BASE_URL must not contain embedded credentials.");
  }
  if (!localHosts.has(url.hostname) && !allowedHosts.has(url.hostname.toLowerCase())) {
    throw new Error(
      `OLLAMA_BASE_URL host ${url.hostname} is not loopback or listed in OLLAMA_ALLOWED_REMOTE_HOSTS.`,
    );
  }
  return url.toString().replace(/\/$/, "");
}

export class OllamaJobMatchProvider implements JobMatchProvider {
  readonly providerName = "ollama" as const;
  readonly model: string;
  private readonly baseUrl: string;

  constructor(private readonly config: OllamaConfig) {
    this.baseUrl = validateOllamaBaseUrl(config.baseUrl, config.allowedRemoteHosts);
    this.model = config.model;
  }

  async assess(input: JobMatchInput, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      body: JSON.stringify({
        model: this.model,
        stream: false,
        think: false,
        format: jobMatchEvidenceJsonSchema,
        messages: [
          { role: "system", content: jobMatchSystemPrompt },
          { role: "user", content: buildJobMatchUserPrompt(input) },
        ],
        options: { temperature: 0 },
        keep_alive: this.config.keepAlive,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as OllamaResponse;
    if (!response.ok) throw new Error(`Ollama request failed (${response.status}): ${body.error ?? "unknown error"}`);
    if (!body.message?.content) throw new Error("Ollama returned no structured message content.");
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.message.content);
    } catch {
      throw new Error("Ollama returned invalid JSON.");
    }
    return jobMatchEvidenceSchema.parse(parsed);
  }
}

export async function verifyOllamaHealth(config: OllamaConfig) {
  const baseUrl = validateOllamaBaseUrl(config.baseUrl, config.allowedRemoteHosts);
  const response = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(Math.min(config.requestTimeoutMs, 10_000)) });
  if (!response.ok) throw new Error(`Ollama health check failed (${response.status}).`);
  const body = (await response.json()) as { models?: Array<{ name?: string }> };
  if (!body.models?.some((model) => model.name === config.model || model.name?.startsWith(`${config.model}:`))) {
    throw new Error(`Ollama model ${config.model} is not installed.`);
  }
}
