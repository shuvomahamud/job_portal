import test from "node:test";
import assert from "node:assert/strict";
import { validateOllamaBaseUrl } from "../src/ai/ollamaClient";

test("Ollama accepts loopback endpoints without an allow-list", () => {
  assert.equal(
    validateOllamaBaseUrl("http://127.0.0.1:11434"),
    "http://127.0.0.1:11434",
  );
});

test("Ollama accepts only an explicitly allow-listed remote host", () => {
  assert.equal(
    validateOllamaBaseUrl("http://100.121.70.118:11434", ["100.121.70.118"]),
    "http://100.121.70.118:11434",
  );
  assert.throws(
    () => validateOllamaBaseUrl("http://100.121.70.119:11434", ["100.121.70.118"]),
    /not loopback or listed/i,
  );
});

test("Ollama rejects unsupported protocols and embedded credentials", () => {
  assert.throws(
    () => validateOllamaBaseUrl("ftp://127.0.0.1:11434"),
    /HTTP or HTTPS/i,
  );
  assert.throws(
    () => validateOllamaBaseUrl("http://user:secret@127.0.0.1:11434"),
    /embedded credentials/i,
  );
});
