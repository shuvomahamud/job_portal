import { timingSafeEqual } from "node:crypto";

export function constantTimeSecretEquals(
  expected: string,
  supplied: string,
) {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return (
    expectedBytes.length === suppliedBytes.length &&
    timingSafeEqual(expectedBytes, suppliedBytes)
  );
}
