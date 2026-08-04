import { describe, expect, test } from "bun:test";
import { normalizeDueDate, toRFC3339 } from "./Tasks.js";

describe("normalizeDueDate", () => {
  test("ISO date only: returns midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime without timezone: returns date portion at midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime with Z: returns date portion at midnight UTC", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00Z")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("ISO datetime with offset: returns UTC date portion at midnight", () => {
    expect(normalizeDueDate("2025-03-19T21:00:00+05:00")).toBe("2025-03-19T00:00:00.000Z");
  });

  test("invalid string throws error", () => {
    expect(() => normalizeDueDate("not-a-date")).toThrow("Invalid due date format");
  });

  test("undefined returns undefined", () => {
    expect(normalizeDueDate(undefined)).toBeUndefined();
  });
});

describe("toRFC3339", () => {
  test("date only: returns midnight UTC", () => {
    expect(toRFC3339("2026-07-06")).toBe("2026-07-06T00:00:00.000Z");
  });

  test("full timestamp is preserved (not truncated to midnight)", () => {
    expect(toRFC3339("2026-07-05T23:59:59Z")).toBe("2026-07-05T23:59:59.000Z");
  });

  test("offset is converted to UTC", () => {
    expect(toRFC3339("2026-07-06T00:00:00+02:00")).toBe("2026-07-05T22:00:00.000Z");
  });

  test("invalid string throws with the given label", () => {
    expect(() => toRFC3339("nope", "dueMin")).toThrow("Invalid dueMin value");
  });
});
