import type { Source } from "../../src/chat/sources.js";

export type Question = {
  id: string;
  group: "newcomer" | "project" | "developer" | "edge";
  ask: string;
  /** Substrings of an acceptable source URL. Empty: no citation required. */
  citesAnyOf: string[];
  /** Case-insensitive substrings. */
  mustInclude: string[];
  mustNotInclude: string[];
};

/** A citation counts only if its id is in the text and its URL is one the question accepts. */
export function grade(question: Question, answer: { text: string; sources: Source[] }): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const text = answer.text.toLowerCase();
  if (question.citesAnyOf.length > 0) {
    const cited = answer.sources.filter(({ id }) => answer.text.includes(`[${id}]`));
    if (!cited.some(({ url }) => question.citesAnyOf.some((part) => url.includes(part))))
      reasons.push(cited.length > 0 ? "cited none of the expected sources" : "cited no source");
  }
  for (const phrase of question.mustInclude) if (!text.includes(phrase.toLowerCase())) reasons.push(`missing "${phrase}"`);
  for (const phrase of question.mustNotInclude) if (text.includes(phrase.toLowerCase())) reasons.push(`includes "${phrase}"`);
  // Every question: the model points at sources by id and never writes an address itself.
  if (/https?:\/\//.test(answer.text)) reasons.push("wrote a URL");
  return { pass: reasons.length === 0, reasons };
}
