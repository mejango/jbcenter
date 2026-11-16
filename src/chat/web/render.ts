const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ESCAPES[character]!);

export type Cited = { n: number; url: string; title: string };

/** Escaped text with bold and citations. A source id the page does not hold stays as text. */
function prose(text: string, lookup: (id: string) => Cited | undefined): string {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    // One id per bracket, or several: models write both.
    .replace(/\[(S-[0-9a-f]{6}(?:[,;]? ?S-[0-9a-f]{6})*)\]/g, (_, ids: string) => ids.match(/S-[0-9a-f]{6}/g)!.map((id) => {
      const source = lookup(id);
      return source && /^https?:\/\//.test(source.url)
        ? `<a href="${escapeHtml(source.url)}" title="${escapeHtml(source.title)}" rel="noopener">[${source.n}]</a>` : `[${id}]`;
    }).join(""));
}

const inline = (text: string, lookup: (id: string) => Cited | undefined) =>
  text.split("`").map((part, index) => (index % 2 ? `<code>${escapeHtml(part)}</code>` : prose(part, lookup))).join("");

/**
 * The model's answer as safe HTML. Everything is escaped first; the only markup is paragraphs, lists,
 * bold and code, and the only links are source ids the page already holds. A markdown link, a bare
 * URL, an image or an element in the model's text stays text.
 */
export function renderAnswer(text: string, lookup: (id: string) => Cited | undefined): string {
  let html = "", open = "", fence: string[] | undefined;
  const close = () => { if (open) html += `</${open}>`; open = ""; };
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      if (fence) html += `<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
      else close();
      fence = fence ? undefined : [];
      continue;
    }
    if (fence) { fence.push(line); continue; }
    const item = /^\s*(?:([-*])|\d+\.)\s+(.*)$/.exec(line);
    const heading = /^#+\s+(.*)$/.exec(line);
    if (item) {
      const list = item[1] ? "ul" : "ol";
      if (open !== list) { close(); html += `<${list}>`; open = list; }
      html += `<li>${inline(item[2]!, lookup)}</li>`;
    } else if (heading) {
      close();
      html += `<p><strong>${inline(heading[1]!, lookup)}</strong></p>`;
    } else if (!line.trim()) close();
    else if (open === "p") html += `<br>${inline(line, lookup)}`;
    else { close(); html += `<p>${inline(line, lookup)}`; open = "p"; }
  }
  // A fence still open while the answer streams is code.
  if (fence) html += `<pre><code>${escapeHtml(fence.join("\n"))}</code></pre>`;
  close();
  return html;
}
