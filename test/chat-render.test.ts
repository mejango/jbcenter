import { describe, expect, it } from "vitest";
import { renderAnswer } from "../src/chat/web/render.js";

const sources: Record<string, { url: string; title: string }> = {
  "S-aaaaaa": { url: "https://github.com/Bananapus/nana-core-v6/blob/abc/src/JBCashOuts.sol#L1-L60", title: 'JBCashOuts.sol "lines"' },
  "S-bbbbbb": { url: "https://juicebox.center/inspect/8453/1", title: "Project 1 on chain 8453" },
  "S-cccccc": { url: "javascript:alert(1)", title: "bad" },
};
const A = '<a href="https://github.com/Bananapus/nana-core-v6/blob/abc/src/JBCashOuts.sol#L1-L60" title="JBCashOuts.sol &quot;lines&quot;" rel="noopener">[1]</a>';
function render(text: string) {
  const seen = new Map<string, number>();
  return renderAnswer(text, (id) => {
    const source = sources[id];
    if (!source) return undefined;
    if (!seen.has(id)) seen.set(id, seen.size + 1);
    return { n: seen.get(id)!, ...source };
  });
}

describe("answer rendering", () => {
  it("links each id of a grouped citation", () => {
    expect(render("Burns [S-aaaaaa, S-bbbbbb]. Unknown [S-aaaaaa; S-dddddd].")).toBe(
      `<p>Burns ${A}<a href="https://juicebox.center/inspect/8453/1" title="Project 1 on chain 8453" rel="noopener">[2]</a>. Unknown ${A}[S-dddddd].</p>`);
  });

  it("turns a known source id into a numbered link", () => {
    expect(render("Burns tokens [S-aaaaaa]. Live [S-bbbbbb], again [S-aaaaaa].")).toBe(
      `<p>Burns tokens ${A}. Live <a href="https://juicebox.center/inspect/8453/1" title="Project 1 on chain 8453" rel="noopener">[2]</a>, again ${A}.</p>`);
  });

  it("leaves an unknown id, or one with an unsafe address, as text", () => {
    expect(render("See [S-dddddd] and [S-cccccc].")).toBe("<p>See [S-dddddd] and [S-cccccc].</p>");
  });

  it("never makes a link, image or element out of the model's own text", () => {
    const html = render('<img src=x onerror=alert(1)> [x](https://evil.example) https://evil.example ![a](https://evil.example/b.png) <a href="https://evil.example">y</a> <script>1</script>');
    expect(html).not.toMatch(/<(?!\/?p>)/);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("[x](https://evil.example)");
  });

  it("renders paragraphs, lists, bold and code, escaped", () => {
    expect(render("One\nline\n\n- a **b**\n- `c<d>` [S-aaaaaa]\n\n1. first\n2. second")).toBe(
      `<p>One<br>line</p><ul><li>a <strong>b</strong></li><li><code>c&lt;d&gt;</code> ${A}</li></ul><ol><li>first</li><li>second</li></ol>`);
    expect(render("```solidity\nif (a < b) { [S-aaaaaa] }\n```\nafter")).toBe("<pre><code>if (a &lt; b) { [S-aaaaaa] }</code></pre><p>after</p>");
    expect(render("## Title\ntext")).toBe("<p><strong>Title</strong></p><p>text</p>");
    // A fence still open while the answer streams is code, not markup.
    expect(render("```\n<b>")).toBe("<pre><code>&lt;b&gt;</code></pre>");
  });
});
