import { createHash } from "node:crypto";
import { BRAND_CSS, BRAND_ICON, FAVICON_LINK } from "./branding.js";
import { HOMEPAGE_JS } from "./directoryClient.js";
import {
  journeyNodes,
  journeyViews,
  type JourneyNode,
  type JourneyView,
} from "./journeyGraph.js";
import {
  directoryTree,
  repositoryGroups,
  type DirectoryNode,
} from "./directory.js";

export const HOMEPAGE_CSS_PATH = "/directory.css";
export const HOMEPAGE_JS_PATH = "/directory.js";
export const HOMEPAGE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
};

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character]!,
  );
}

const RPC_EXAMPLE = String.raw`curl https://juicebox.center/v1/rpc/8453 \
  -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'`;

const PIN_JSON_EXAMPLE = `const response = await fetch(
  'https://juicebox.center/v1/pins/json',
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'My project',
      description: 'Project description'
    })
  }
);
if (!response.ok) throw new Error('Upload failed: ' + response.status);
const { cid, uri, gatewayUrl } = await response.json();`;

const PIN_FILE_EXAMPLE = `// file is a File selected by the user.
const form = new FormData();
form.append('file', file);
const response = await fetch(
  'https://juicebox.center/v1/pins/file',
  { method: 'POST', body: form }
);
if (!response.ok) throw new Error('Upload failed: ' + response.status);
const { cid, uri, gatewayUrl } = await response.json();`;

const API_CONTENT = {
  rpc: `<div class="resource-panel" data-flow-node>
    <p>Read blockchain data through <a href="/api#glossary-rpc">RPC</a>, the request format used by wallets and apps.</p>
    <p class="access">Public. No API key.</p>
    <code class="endpoint">POST https://juicebox.center/v1/rpc/:chainId</code>
    <table>
      <caption>Choose a chain ID</caption>
      <thead><tr><th scope="col">Network</th><th scope="col">Real funds (mainnet)</th><th scope="col">Test funds (Sepolia)</th></tr></thead>
      <tbody>
        <tr><th scope="row">Ethereum</th><td>1</td><td>11155111</td></tr>
        <tr><th scope="row">Optimism</th><td>10</td><td>11155420</td></tr>
        <tr><th scope="row">Base</th><td>8453</td><td>84532</td></tr>
        <tr><th scope="row">Arbitrum</th><td>42161</td><td>421614</td></tr>
      </tbody>
    </table>
    <details class="example"><summary>Example: read a Base block number</summary><pre><code>${escapeHtml(RPC_EXAMPLE)}</code></pre></details>
    <p class="note">Send one JSON-RPC object per request. Read data or test a call within the published limits; send transactions through your wallet. HTTP 429 means too many requests.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#read-ethereum-rpc">RPC documentation ↗</a>
    <a class="reference" href="https://github.com/mejango/jbcenter/blob/main/src/rpc.ts">Methods and limits ↗</a>
  </div>`,
  ipfs: `<div class="resource-panel" data-flow-node>
    <p>Retrieve files from <a href="/api#glossary-ipfs">IPFS</a>, a shared file network. A file's content gives it an identifier called a CID.</p>
    <p class="access">Public. No API key.</p>
    <code class="endpoint">GET https://juicebox.center/ipfs/:cid[/path]</code>
    <p><code>ipfs://CID/image.png</code> becomes:</p>
    <code class="endpoint">https://juicebox.center/ipfs/CID/image.png</code>
    <p class="note">Apps on other sites can read files and request parts of a media file. Up to 500 MiB. HTML, scripts, CSS, XML, PDFs, and Wasm download as files.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#pin-and-read-ipfs-content">Gateway documentation ↗</a>
  </div>`,
  pinning: `<div class="resource-panel" data-flow-node>
    <p>Upload public files to IPFS. Keeping a copy available is called pinning.</p>
    <p class="access">Uploads must come from an approved app</p>
    <p>Browser uploads: <a href="https://juicebox.money">juicebox.money</a>, <a href="https://revnet.money">revnet.money</a>, <a href="https://eth.shop">eth.shop</a>, <a href="https://succulent.money">succulent.money</a>, or <a href="https://homerun.money">homerun.money</a>.</p>
    <table class="pin-routes">
      <caption>POST to https://juicebox.center</caption>
      <thead><tr><th scope="col">Path</th><th scope="col">Body</th><th scope="col">Max</th></tr></thead>
      <tbody>
        <tr><th scope="row"><code>/v1/pins/json</code></th><td>JSON object</td><td>2 MiB</td></tr>
        <tr><th scope="row"><code>/v1/pins/file</code></th><td>Image</td><td>25 MiB</td></tr>
        <tr><th scope="row"><code>/v1/pins/media</code></th><td>Image, video, audio, PDF, text</td><td>500 MiB</td></tr>
      </tbody>
    </table>
    <details class="example"><summary>Example: upload JSON</summary><pre><code>${escapeHtml(PIN_JSON_EXAMPLE)}</code></pre></details>
    <details class="example"><summary>Example: upload a file</summary>
      <p>Use the multipart field <code>file</code>. The browser sets Origin and Content-Type. Use <code>/v1/pins/media</code> for video, audio, PDF, or text.</p>
      <pre><code>${escapeHtml(PIN_FILE_EXAMPLE)}</code></pre>
    </details>
    <p class="note">HTTP 201 returns <code>cid</code>, <code>uri</code> (<code>ipfs://…</code>), <code>gatewayUrl</code> (<code>/ipfs/…</code>), and <code>status: "queued"</code> for a second stored copy. Queued means that copy is still waiting. Uploads are public.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#pin-and-read-ipfs-content">Upload documentation ↗</a>
    <a class="reference" href="https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md">Publish project details with an agent ↗</a>
  </div>`,
  mcp: `<div class="resource-panel" data-flow-node>
    <p>Give an assistant access to Juicebox tools through <a href="/api#glossary-mcp">MCP</a>, a shared format for connecting AI apps to tools.</p>
    <p class="access">Use a compatible client with Streamable HTTP.</p>
    <code class="endpoint">https://juicebox.center/mcp</code>
  </div>`,
};

function nodeChildren(
  node: DirectoryNode,
): readonly DirectoryNode[] | undefined {
  return node.content === "repositories"
    ? repositoryGroups.map((category) => ({
        title: category.title,
        children: category.links.map(({ title, url, description }) => ({
          title,
          url,
          note: description,
        })),
      }))
    : node.children;
}

function renderDestinationTitle(title: string): string {
  const [action, resource] = title.split(" → ");
  return resource
    ? `<span class="node-label"><span class="node-action">${escapeHtml(action!)}</span><span class="node-resource">${escapeHtml(resource)}</span></span>`
    : `<span class="node-resource">${escapeHtml(title)}</span>`;
}

function renderContents(node: DirectoryNode, group: string): string {
  const content =
    node.content && node.content !== "repositories"
      ? API_CONTENT[node.content]
      : "";
  const children = nodeChildren(node);
  return `${content}
    ${node.content === "repositories" ? '<a class="reference" href="https://github.com/Bananapus/version-6">V6 top-level repository ↗</a>' : ""}
    ${children ? `<ul class="choices">${children.map((child, index) => renderNode(child, group, index)).join("")}</ul>` : ""}`;
}

function renderNode(node: DirectoryNode, group: string, index: number): string {
  const title = escapeHtml(node.title);
  if (node.url) {
    return `<li class="destination" data-flow-node>
      <a class="destination-link" href="${escapeHtml(node.url)}">${renderDestinationTitle(node.title)}<span class="external-arrow" aria-hidden="true">↗</span></a>
      ${node.sourceUrl ? `<a class="source-link" href="${escapeHtml(node.sourceUrl)}">Source<span class="visually-hidden">: ${title}</span></a>` : ""}
      ${node.note ? `<p class="note">${escapeHtml(node.note)}</p>` : ""}
    </li>`;
  }
  return `<li class="branch"><details${node.id ? ` id="directory-${escapeHtml(node.id)}"` : ""} name="${group}">
    <summary data-flow-node><span>${title}</span><span class="marker" aria-hidden="true"></span></summary>
    <div class="branch-content">${renderContents(node, `${group}-${index}`)}</div>
  </details></li>`;
}

const graphNodes = new Map(journeyNodes.map((node) => [node.id, node]));

function targetView(target: string, current: JourneyView): JourneyView {
  if (current.layout.some((placement) => placement.node === target))
    return current;
  const homeView = graphNodes.get(target)?.homeView;
  const found =
    journeyViews.find((view) => view.id === homeView) ??
    journeyViews.find((view) => view.entry === target) ??
    journeyViews.find((view) =>
      view.layout.some((placement) => placement.node === target),
    );
  if (!found) throw new Error(`Missing journey view for ${target}`);
  return found;
}

function referenceContent(
  content: NonNullable<JourneyNode["content"]>,
  key: string,
): string {
  if (content === "repositories")
    return renderContents({ title: "Repositories", content }, key);
  if (content === "wip") {
    return renderContents(
      directoryTree.find((node) => node.id === "wip")!,
      key,
    );
  }
  if (content === "webclients") {
    const clients = directoryTree
      .find((node) => node.id === "developers")!
      .children!.find((node) => node.children)!;
    return renderContents(clients, key);
  }
  return API_CONTENT[content];
}

const referenceLabels: Record<NonNullable<JourneyNode["content"]>, string> = {
  rpc: "RPC endpoint and examples",
  ipfs: "IPFS gateway details",
  pinning: "Upload routes and examples",
  mcp: "MCP endpoint",
  repositories: "All source repositories",
  webclients: "App source code",
  wip: "Unfinished projects and status",
};

const RETURN_ICON = `<svg class="return-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" focusable="false"><path d="m9 4-5 5 5 5M4 9h10a6 6 0 0 1 0 12h-3"/></svg>`;

function renderJourney(view: JourneyView): string {
  return `<section class="journey-map" id="map-${view.id}" data-view="${view.id}" data-entry="${view.entry}" aria-labelledby="map-title-${view.id}">
    <h2 class="map-title" id="map-title-${view.id}">${escapeHtml(view.title)}</h2>
    <svg class="journey-lines" aria-hidden="true" focusable="false"></svg>
    <div class="journey-grid">${[...view.layout]
      .sort((a, b) => a.row - b.row || a.column - b.column)
      .map((placement) => {
        const node = graphNodes.get(placement.node)!;
        return `<article class="journey-node ${node.kind} column-${placement.column} row-${placement.row}" id="${view.id}/${node.id}" data-node="${node.id}" data-content="${node.content ?? ""}" tabindex="-1" aria-labelledby="heading-${view.id}-${node.id}">
        <h3 id="heading-${view.id}-${node.id}">${escapeHtml(node.title)}</h3>
        ${node.prompt ? `<p class="node-prompt">${escapeHtml(node.prompt)}</p>` : ""}
        ${node.note ? `<p class="note">${escapeHtml(node.note)}</p>` : ""}
        ${node.links?.length ? `<ul class="resource-links">${node.links.map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)} <span aria-hidden="true">↗</span></a></li>`).join("")}</ul>` : ""}
        ${node.content ? `<details class="node-reference"><summary>${referenceLabels[node.content]}</summary>${referenceContent(node.content, `graph-${view.id}-${node.id}`)}</details>` : ""}
        ${
          node.edges.length
            ? `${node.kind === "resource" ? '<p class="continuation-label">Optional next steps</p>' : ""}<ul class="edge-choices">${node.edges
                .map((edge) => {
                  const destination = targetView(edge.to, view);
                  const kind = edge.kind ?? "next";
                  const symbol =
                    kind === "return"
                      ? RETURN_ICON
                      : destination.id !== view.id
                        ? "↗"
                        : "→";
                  return `<li><a class="journey-edge ${kind}" href="#${destination.id}/${edge.to}" data-from="${node.id}" data-to="${edge.to}" data-target-view="${destination.id}" data-kind="${kind}"><span>${escapeHtml(graphNodes.get(edge.to)!.title)}</span><span aria-hidden="true">${symbol}</span></a></li>`;
                })
                .join("")}</ul>`
            : ""
        }
      </article>`;
      })
      .join("")}</div>
  </section>`;
}

export const HOMEPAGE_CSS = `
${BRAND_CSS}
:root {
  color-scheme: light;
  --paper: #f5f4ef;
  --node: #fbfaf6;
  --ink: #272b26;
  --muted: #596155;
  --line: #c8ccc1;
  --accent: #245638;
  --selected: #e7eddf;
  --return: #815a30;
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; font-size: 14px; line-height: 1.65; }
a { color: inherit; text-underline-offset: 4px; text-decoration-thickness: 1px; }
a:hover, summary:hover { color: var(--accent); }
a:focus-visible, summary:focus-visible, button:focus-visible, article:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
p, h1, h2, h3 { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
code { font: inherit; overflow-wrap: anywhere; }
.page { max-width: 1320px; margin: 0 auto; padding: 0 40px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 24px 0; border-bottom: 1px solid var(--ink); }
.wordmark { font-size: 18px; font-weight: 600; text-decoration: none; letter-spacing: -0.5px; }
.edition { color: var(--muted); font-size: 12px; }
h1 { font-size: clamp(26px, 4.5vw, 38px); line-height: 1.2; letter-spacing: -0.045em; font-weight: 500; margin: 32px 0 18px; }
.introduction { max-width: 940px; font-size: 14px; color: var(--muted); margin-bottom: 32px; }
h2 { font-size: 18px; line-height: 1.5; font-weight: 500; }
h3 { font-size: 15px; line-height: 1.5; font-weight: 500; }
.journey-tabs, .journey-map, .map-key { display: none; }
.is-enhanced .journey-tabs { display: block; margin: 24px 0; }
.journey-tabs h2 { margin-bottom: 14px; }
.journey-tabs ul { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.journey-tabs button { width: 100%; height: 100%; min-height: 48px; padding: 12px 14px; border: 1px solid var(--line); background: var(--node); text-align: left; font-size: 12px; }
.journey-tabs button:hover { border-color: var(--accent); }
.journey-tabs button.selected, .journey-tabs button[aria-expanded="true"] { border-color: var(--accent); background: var(--selected); color: var(--accent); }
.is-enhanced .map-key { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 24px; margin: 22px 0 8px; font-size: 11px; color: var(--muted); }
.map-key .return-key { display: inline-flex; align-items: center; gap: 6px; color: var(--return); }
.return-icon { display: block; width: 22px; height: 22px; flex-shrink: 0; }
.is-enhanced .journey-map { display: block; position: relative; padding: 24px; margin: 0 0 28px; }
.map-title { margin-bottom: 28px; }
.journey-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); grid-auto-rows: auto; align-items: start; gap: 64px; }
.column-1 { grid-column: 1; }.column-2 { grid-column: 2; }.column-3 { grid-column: 3; }
${Array.from({ length: Math.max(...journeyViews.flatMap((view) => view.layout.map((placement) => placement.row))) }, (_, index) => `.row-${index + 1} { grid-row: ${index + 1}; }`).join("\n")}
.journey-node { position: relative; z-index: 1; min-width: 0; padding: 18px; border: 1px solid var(--line); background: var(--node); scroll-margin-top: 24px; }
.journey-node.question { background: var(--paper); border-color: #a5afa0; }
.journey-node.resource { border-top: 3px solid var(--accent); }
.journey-node.current { border-color: var(--accent); background: var(--selected); }
.node-prompt { margin-top: 8px; font-size: 12px; color: var(--muted); }
.journey-node > .note { margin-top: 10px; }
.resource-links { margin-top: 12px; }
.resource-links a { display: inline-block; font-size: 12px; padding: 7px 0; }
.edge-choices { margin-top: 16px; border-top: 1px solid var(--line); }
.continuation-label { margin-top: 16px; font-size: 11px; color: var(--muted); }
.continuation-label + .edge-choices { margin-top: 8px; }
.edge-choices li + li { border-top: 1px solid var(--line); }
.journey-edge { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 40px; padding: 10px 0; font-size: 12px; text-decoration: none; }
.journey-edge:hover > span:first-child { text-decoration: underline; }
.journey-edge > span:last-child { flex-shrink: 0; color: var(--accent); }
.journey-edge.return { color: var(--return); }
.journey-edge.return > span:last-child { color: inherit; }
.journey-lines { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.journey-lines path { fill: none; stroke: #a5afa0; stroke-width: 1.25; vector-effect: non-scaling-stroke; }
.journey-lines path.return { stroke: var(--return); stroke-dasharray: 5 4; }
.journey-lines path.cross { stroke-dasharray: 2 3; }
.journey-lines path.active { stroke: var(--accent); stroke-width: 2; }
.journey-lines path.return.active { stroke: var(--return); }
.node-reference { margin-top: 14px; }
summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; list-style: none; cursor: pointer; padding: 12px; min-height: 44px; border: 1px solid var(--line); background: var(--node); font-size: 12px; }
summary::-webkit-details-marker { display: none; }
summary:hover { border-color: var(--accent); }
summary::after { content: "+"; color: var(--accent); flex-shrink: 0; }
details[open] > summary::after { content: "−"; }
summary:has(.marker)::after { display: none; }
.marker::before { content: "+"; color: var(--accent); }
details[open] > summary .marker::before { content: "−"; }
.node-reference > .resource-panel { margin: 14px 0 0; padding: 0; border: 0; }
.node-reference .choices { margin-top: 14px; }
.resource-panel { padding: 16px; font-size: 12px; border: 1px solid var(--line); background: var(--node); margin-bottom: 16px; }
.resource-panel p { margin-bottom: 14px; }
.resource-panel .access { font-size: 12px; color: var(--accent); }
.endpoint { display: block; font-size: 11px; margin: 10px 0 20px; }
table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 11px; }
caption { text-align: left; color: var(--muted); margin-bottom: 8px; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 8px 4px 8px 0; overflow-wrap: anywhere; }
th { font-weight: 500; }
thead { color: var(--muted); }
.pin-routes th:first-child { width: 40%; }
.example { margin: 12px 0; }
.example > summary { padding: 10px; font-size: 12px; }
.example > p { margin-top: 14px; }
pre { margin: 12px 0 16px; padding: 12px; border: 1px solid var(--line); font: inherit; font-size: 11px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.directory-reference { margin: 32px 0; }
.directory-reference > summary { font-size: 14px; background: var(--paper); padding: 16px; }
.directory-reference > .choices { margin: 20px 0; }
.choices > li + li { margin-top: 14px; }
.branch-content { margin: 20px 0 8px 4px; padding-left: 20px; border-left: 1px solid var(--line); }
.destination { min-width: 0; border: 1px solid var(--line); background: var(--node); padding: 14px; }
.destination-link { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 30px; text-decoration: none; overflow-wrap: anywhere; }
.destination-link:hover .node-resource { text-decoration: underline; }
.node-label { display: grid; gap: 3px; }
.node-action { font-size: 11px; color: var(--muted); }
.node-resource { font-size: 13px; line-height: 1.5; }
.external-arrow { color: var(--accent); flex-shrink: 0; }
.source-link { font-size: 11px; min-height: 28px; display: inline-flex; align-items: center; margin-top: 4px; }
.note { color: var(--muted); font-size: 11px; }
.destination .note { margin-top: 8px; }
.reference { display: inline-block; margin: 4px 16px 12px 0; font-size: 11px; padding: 4px 0; }
footer { display: flex; flex-wrap: wrap; gap: 8px 28px; padding: 24px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
footer a { display: inline-flex; align-items: center; min-height: 32px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 20px; top: -100px; padding: 10px; background: var(--paper); z-index: 3; }
.skip-link:focus { top: 8px; }
@media (max-width: 1000px) and (min-width: 761px) {
  .page { padding: 0 24px; }
  .journey-grid { gap: 48px; }
  .journey-node { padding: 12px; }
  .journey-node h3 { font-size: 13px; }
}
@media (max-width: 760px) {
  .page { padding: 0 20px; }
  header { padding: 20px 0; }
  .wordmark { font-size: 16px; }
  h1 { margin: 24px 0 16px; }
  .introduction { font-size: 13px; margin-bottom: 24px; }
  .journey-tabs ul { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .journey-tabs button { font-size: 11px; }
  .is-enhanced .journey-map { padding: 16px; }
  .journey-grid { display: flex; flex-direction: column; gap: 40px; }
  .journey-node { width: 100%; padding: 14px; }
  .branch-content { padding-left: 14px; margin-left: 0; }
  .destination, .resource-panel { padding: 10px; }
  table, .endpoint, pre { font-size: 10px; }
}
@media print {
  :root { background: white; color: black; }
  .page { max-width: none; padding: 0; }
  .skip-link, .journey-tabs, .journey-lines, .map-key { display: none !important; }
  .is-enhanced .journey-map[hidden] { display: block !important; }
  .journey-grid { display: block; }
  .journey-node { break-inside: avoid; margin: 16px 0; }
}
`;

export const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Find Juicebox apps, learn how projects work, build an integration, and check the code.">
  <script defer src="${HOMEPAGE_JS_PATH}?v=${createHash("sha256").update(HOMEPAGE_JS).digest("hex").slice(0, 12)}"></script>
  <meta name="theme-color" content="#f5f4ef">
  <title>Juicebox Center</title>
  ${FAVICON_LINK}
  <link rel="canonical" href="https://juicebox.center/">
  <link rel="stylesheet" href="${HOMEPAGE_CSS_PATH}?v=${createHash("sha256").update(HOMEPAGE_CSS).digest("hex").slice(0, 12)}">
</head>
<body>
  <a class="skip-link" href="#main">Skip to directory</a>
  <div class="page">
    <header>
      <a class="wordmark" href="/">${BRAND_ICON} juicebox.center</a>
      <span class="edition">V6</span>
    </header>
    <main id="main">
      <h1>Everything Juicebox in one place</h1>
      <p class="introduction">Juicebox lets projects raise and share money under rules anyone can check. Find an app, learn how it works, or build your own. <a href="https://juicebox.money/learn">Start with the basics</a> or look up a word in the <a href="/api#glossary">glossary</a>.</p>
      <section class="journey-explorer" aria-label="Juicebox journeys">
        <nav class="journey-tabs" aria-labelledby="choose-journey">
          <h2 id="choose-journey">What do you want to do?</h2>
          <ul>${journeyViews.map((view) => `<li><button type="button" id="journey-${view.id}" data-view="${view.id}" aria-controls="map-${view.id}" aria-expanded="false">${escapeHtml(view.title)}</button></li>`).join("")}</ul>
        </nav>
        <p class="map-key"><span>→ Next step</span><span class="return-key">${RETURN_ICON}Revisit a decision</span><span>↗ Related path</span></p>
        ${journeyViews.map(renderJourney).join("")}
        <details class="directory-reference" id="directory" open>
          <summary>Already know what you need? Browse the directory</summary>
          <ul class="choices">${directoryTree.map((node, index) => renderNode(node, "directory", index)).join("")}</ul>
        </details>
      </section>
    </main>
    <footer>
      <a href="https://github.com/mejango/jbcenter/blob/main/src/directory.ts">Improve this directory ↗</a>
      <a href="https://github.com/Bananapus/version-6/issues">Report an issue ↗</a>
      <a href="/api#glossary">Glossary</a>
    </footer>
  </div>
</body>
</html>`;
