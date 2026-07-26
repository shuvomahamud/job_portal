import assert from "node:assert/strict";
import { OllamaJobMatchProvider } from "../src/ai/ollamaClient";

if (process.env.RUN_OLLAMA_SMOKE !== "true") {
  throw new Error("Set RUN_OLLAMA_SMOKE=true to send the opt-in local Ollama smoke request.");
}

async function main() {
  const provider = new OllamaJobMatchProvider({
    baseUrl: process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3.5:9b",
    requestTimeoutMs: Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS ?? 90_000),
    keepAlive: process.env.OLLAMA_KEEP_ALIVE ?? "30m",
  });

  const evidence = await provider.assess({
    candidate: {
      targetTitles: ["Senior .NET Developer"],
      targetLocations: ["Remote"],
      skills: ["C#", ".NET", "SQL Server", "Azure"],
      preferredEmploymentTypes: ["W2 contract"],
      workAuthorizationAnswer: "Authorized to work through an H-1B transfer.",
      sponsorshipAnswer: "Requires H-1B transfer sponsorship.",
      salaryExpectation: null,
      summary: "Senior C# and .NET engineer with SQL Server, Azure, and production support experience.",
      dealBreakers: [],
      matchingInstructions: null,
    },
    job: {
      id: "smoke-job",
      title: "Senior .NET Developer",
      company: "Example Staffing",
      location: "Remote",
      source: "indeed",
      sourceUrl: "https://www.indeed.com/viewjob?jk=smoke",
      description: "Remote W2 contract role for a Senior .NET Developer. Requires C#, ASP.NET, SQL Server, Azure, and production support. H-1B transfer is considered.",
      salaryText: null,
      employmentType: "w2-contract",
      remoteType: "remote",
      visaSignal: "h1b_transfer_explicit",
      techStack: [".NET", "C#", "SQL", "Azure", "Production Support"],
    },
  });

  assert.equal(evidence.schemaVersion, "job-match-v1");
  assert.ok(evidence.summary.length > 0);
  console.log(JSON.stringify({ ok: true, model: provider.model, roleFit: evidence.roleFit, skillFit: evidence.skillFit, authorizationFit: evidence.authorizationFit }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
