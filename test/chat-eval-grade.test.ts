import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { grade, type Question } from "../evals/chat/grade.js";
import type { Source } from "../src/chat/sources.js";

const question: Question = { id: "q", group: "developer", ask: "How do cash outs work?", citesAnyOf: ["nana-core-v6"], mustInclude: ["burn"], mustNotInclude: ["guaranteed"] };
const core: Source = { id: "S-aaaaaa", title: "JBMultiTerminal.sol", url: "https://github.com/Bananapus/nana-core-v6/blob/abc/src/JBMultiTerminal.sol", kind: "reference" };
const other: Source = { id: "S-bbbbbb", title: "README", url: "https://github.com/Bananapus/juice-sdk-v4/blob/abc/README.md", kind: "reference" };

describe("chat answer grading", () => {
  it("passes an answer that cites an expected source", () => {
    expect(grade(question, { text: "Cash outs BURN tokens [S-aaaaaa].", sources: [core, other] })).toEqual({ pass: true, reasons: [] });
  });

  it("fails when the expected source was found but not cited in the text", () => {
    expect(grade(question, { text: "Cash outs burn tokens [S-bbbbbb].", sources: [core, other] })).toEqual({ pass: false, reasons: ["cited none of the expected sources"] });
    expect(grade(question, { text: "Cash outs burn tokens.", sources: [core] })).toEqual({ pass: false, reasons: ["cited no source"] });
  });

  it("fails on a forbidden phrase, a missing one, or a written URL", () => {
    expect(grade(question, { text: "Returns are Guaranteed [S-aaaaaa]. See https://example.com", sources: [core] }).reasons)
      .toEqual(['missing "burn"', 'includes "guaranteed"', "wrote a URL"]);
  });

  it("needs no citation when none is expected", () => {
    expect(grade({ ...question, citesAnyOf: [], mustInclude: ["do not know"] }, { text: "I do not know.", sources: [] }).pass).toBe(true);
  });
});

describe("chat question set", () => {
  const questions: Question[] = JSON.parse(readFileSync(new URL("../evals/chat/questions.json", import.meta.url), "utf8"));

  it("has 30 questions with unique ids: 8 newcomer, 8 project, 8 developer, 6 edge", () => {
    expect(new Set(questions.map(({ id }) => id)).size).toBe(30);
    const count = (group: string) => questions.filter((item) => item.group === group).length;
    expect([count("newcomer"), count("project"), count("developer"), count("edge")]).toEqual([8, 8, 8, 6]);
    for (const item of questions) {
      expect(Object.keys(item).sort(), item.id).toEqual(["ask", "citesAnyOf", "group", "id", "mustInclude", "mustNotInclude"]);
      expect(item.ask).not.toMatch(/·/);
    }
  });
});
