import assert from "node:assert/strict";
import test from "node:test";
import { requireCommandUserId } from "../src/requireCommandUserId";

test("requireCommandUserId accepts a UUID", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  assert.equal(requireCommandUserId(id), id);
});

test("requireCommandUserId rejects hermes and other non-UUID values", () => {
  assert.throws(() => requireCommandUserId("hermes"), /user UUID/);
  assert.throws(() => requireCommandUserId(""), /user UUID/);
});
