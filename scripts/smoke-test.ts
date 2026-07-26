import assert from "node:assert/strict";
import {
  commandCreateSchema,
  jobImportSchema,
  jobUpdateSchema,
  validateCommandPayload,
  workerClaimSchema,
} from "../src/lib/validation";
import { apiErrorResponse } from "../src/lib/api";
import { constantTimeSecretEquals } from "../src/lib/security-core";

async function main() {
  const command = commandCreateSchema.parse({
    type: "run_job_search",
    payloadJson: {
      sources: ["indeed"],
      queries: ["senior software engineer"],
      limit: 25,
    },
    priority: "normal",
  });
  validateCommandPayload(command.type, command.payloadJson);

  assert.throws(() =>
    validateCommandPayload("run_job_search", {
      sources: ["indeed"],
      shell: "rm -rf /",
    }),
  );
  assert.throws(() =>
    commandCreateSchema.parse({
      type: "execute_shell",
      payloadJson: { command: "whoami" },
    }),
  );
  assert.equal(jobUpdateSchema.safeParse({}).success, false);
  assert.equal(
    jobImportSchema.safeParse({
      title: "Role",
      company: "Company",
      source: "manual",
      sourceUrl: "not-a-url",
      description: "Description",
    }).success,
    false,
  );
  assert.equal(
    jobImportSchema.safeParse({
      title: "Role",
      company: "Company",
      source: "manual",
      sourceUrl: "javascript:alert(1)",
      description: "Description",
    }).success,
    false,
  );

  assert.equal(
    constantTimeSecretEquals(
      "worker-test-secret-123456789",
      "wrong-secret",
    ),
    false,
  );
  assert.equal(
    constantTimeSecretEquals(
      "worker-test-secret-123456789",
      "worker-test-secret-123456789",
    ),
    true,
  );

  const invalidClaim = workerClaimSchema.safeParse({ workerId: "" });
  assert.equal(invalidClaim.success, false);
  if (invalidClaim.success) {
    throw new Error("Expected worker claim validation to fail.");
  }
  const invalidClaimResponse = apiErrorResponse(invalidClaim.error);
  assert.equal(invalidClaimResponse.status, 422);
  const invalidClaimBody = await invalidClaimResponse.json();
  assert.equal(invalidClaimBody.error.code, "VALIDATION_ERROR");

  console.log(
    "Smoke tests passed: allow-list, raw execution rejection, URL validation, scoped secrets, and API validation.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
