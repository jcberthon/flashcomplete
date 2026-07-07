import { describe, expect, it } from "vitest";
import {
  getLeadingWhitespace,
  removeLeadingWhitespace,
  removeTrailingNewLines,
  shouldDiscardSuggestion,
  updateSuggestion,
} from "../src/postprocess.js";
import type { DocumentSnapshot } from "../src/types.js";

function snap(lines: string[], cursorLine: number, cursorChar: number): DocumentSnapshot {
  return { lines, cursorLine, cursorChar, fileName: "/test/file.ts" };
}

describe("removeTrailingNewLines", () => {
  it("drops trailing whitespace-only lines in place", () => {
    const lines = ["code", "  ", ""];
    removeTrailingNewLines(lines);
    expect(lines).toEqual(["code"]);
  });

  it("keeps interior blank lines", () => {
    const lines = ["a", "", "b"];
    removeTrailingNewLines(lines);
    expect(lines).toEqual(["a", "", "b"]);
  });
});

describe("leading whitespace helpers", () => {
  it("extracts leading spaces and tabs", () => {
    expect(getLeadingWhitespace("  \tfoo")).toBe("  \t");
    expect(getLeadingWhitespace("foo")).toBe("");
  });

  it("strips at most n leading whitespace characters", () => {
    expect(removeLeadingWhitespace("    foo", 2)).toBe("  foo");
    expect(removeLeadingWhitespace("\t\tfoo", 4)).toBe("foo");
    expect(removeLeadingWhitespace("foo", 4)).toBe("foo");
  });
});

describe("updateSuggestion", () => {
  it("trims a first line that ends with the line suffix", () => {
    expect(updateSuggestion(["a + b)"], ")")).toBe("a + b");
  });

  it("keeps only the first line of a multi-line suggestion when a suffix exists", () => {
    expect(updateSuggestion(["a + b", "more()"], ")")).toBe("a + b");
  });

  it("joins all lines when the line suffix is blank", () => {
    expect(updateSuggestion(["a + b;", "return c;"], "")).toBe("a + b;\nreturn c;");
  });
});

describe("shouldDiscardSuggestion", () => {
  const doc = ["function f() {", "  return 1;", "}", "const next = 2;"];

  it("discards an empty suggestion", () => {
    expect(shouldDiscardSuggestion([], snap(doc, 0, 14), "function f() {", "")).toBe(true);
  });

  it("discards a whitespace-only single-line suggestion", () => {
    expect(shouldDiscardSuggestion(["   "], snap(doc, 0, 14), "function f() {", "")).toBe(true);
  });

  it("never discards when the cursor is on the last line", () => {
    expect(
      shouldDiscardSuggestion(["const next = 2;"], snap(doc, 3, 15), "const next = 2;", ""),
    ).toBe(false);
  });

  it("discards a suggestion that repeats the following lines after a blank first line", () => {
    expect(
      shouldDiscardSuggestion(["", "  return 1;", "}"], snap(doc, 0, 14), "function f() {", ""),
    ).toBe(true);
  });

  it("discards a single-line suggestion equal to the line suffix", () => {
    // cursor inside "  return 1;" before " 1;"
    expect(shouldDiscardSuggestion([" 1;"], snap(doc, 1, 8), "  return", " 1;")).toBe(true);
  });

  it("discards a suggestion that reproduces the next non-empty line", () => {
    const docWithGap = ["function f() {", "", "  return 1;", "}"];
    // linePrefix + suggestion exactly equals the next non-empty line → discard
    expect(shouldDiscardSuggestion(["  return 1;"], snap(docWithGap, 0, 0), "", "")).toBe(true);
    // same suggestion but a diverging line prefix → kept
    expect(shouldDiscardSuggestion(["  return 1;"], snap(docWithGap, 0, 1), "x", "")).toBe(false);
  });

  it("keeps a genuinely new suggestion", () => {
    expect(shouldDiscardSuggestion(["console.log(1);"], snap(doc, 1, 8), "  return", "1;")).toBe(
      false,
    );
  });

  it("keeps a suggestion when only empty lines follow", () => {
    const docTrailing = ["const a = 1;", "", ""];
    expect(
      shouldDiscardSuggestion(["const b = 2;"], snap(docTrailing, 0, 12), "const a = 1;", ""),
    ).toBe(false);
  });
});
