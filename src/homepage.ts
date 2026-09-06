import { createHash } from "node:crypto";
import { HOMEPAGE_JS } from "./directoryClient.js";
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
    "default-src 'none'; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
    <p class="access">Public. No API key.</p>
    <code class="endpoint">POST https://juicebox.center/v1/rpc/:chainId</code>
    <table>
      <caption>Choose a chain ID</caption>
      <thead><tr><th scope="col">Network</th><th scope="col">Mainnet</th><th scope="col">Sepolia</th></tr></thead>
      <tbody>
        <tr><th scope="row">Ethereum</th><td>1</td><td>11155111</td></tr>
        <tr><th scope="row">Optimism</th><td>10</td><td>11155420</td></tr>
        <tr><th scope="row">Base</th><td>8453</td><td>84532</td></tr>
        <tr><th scope="row">Arbitrum</th><td>42161</td><td>421614</td></tr>
      </tbody>
    </table>
    <details class="example"><summary>Example: read a Base block number</summary><pre><code>${escapeHtml(RPC_EXAMPLE)}</code></pre></details>
    <p class="note">One JSON-RPC object per request. Reads and bounded simulations; submit transactions through your wallet. Handle HTTP 429 rate limits.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#read-ethereum-rpc">RPC documentation ↗</a>
    <a class="reference" href="https://github.com/mejango/jbcenter/blob/main/src/rpc.ts">Methods and limits ↗</a>
  </div>`,
  ipfs: `<div class="resource-panel" data-flow-node>
    <p class="access">Public. No API key.</p>
    <code class="endpoint">GET https://juicebox.center/ipfs/:cid[/path]</code>
    <p><code>ipfs://CID/image.png</code> becomes:</p>
    <code class="endpoint">https://juicebox.center/ipfs/CID/image.png</code>
    <p class="note">Cross-origin reads and media byte ranges. Up to 500 MiB. HTML, scripts, CSS, XML, PDFs, and Wasm download as files.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#pin-and-read-ipfs-content">Gateway documentation ↗</a>
  </div>`,
  pinning: `<div class="resource-panel" data-flow-node>
    <p class="access">Approved app origins required</p>
    <p>Browser uploads: <a href="https://juicebox.money">juicebox.money</a>, <a href="https://revnet.money">revnet.money</a>, <a href="https://eth.shop">eth.shop</a>, or <a href="https://succulent.money">succulent.money</a>.</p>
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
    <p class="note">HTTP 201 returns <code>cid</code>, <code>uri</code> (<code>ipfs://…</code>), <code>gatewayUrl</code> (<code>/ipfs/…</code>), and <code>status: "queued"</code> for the redundant pin. Uploads are public.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#pin-and-read-ipfs-content">Upload documentation ↗</a>
    <a class="reference" href="https://github.com/mejango/jbcenter/blob/main/mcp/docs/USER_JOURNEYS.md">Publish reviewed metadata with an agent ↗</a>
  </div>`,
  mcp: `<div class="resource-panel" data-flow-node>
    <p class="access">Streamable HTTP. Any compatible agent.</p>
    <code class="endpoint">https://juicebox.center/mcp</code>
  </div>`,
};

function nodeChildren(
  node: DirectoryNode,
): readonly DirectoryNode[] | undefined {
  return node.content === "repositories"
    ? repositoryGroups.map((category) => ({
        title: category.title,
        children: category.links.map(({ title, url }) => ({ title, url })),
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
  return `<li class="branch"><details${node.id ? ` id="${escapeHtml(node.id)}"` : ""} name="${group}">
    <summary data-flow-node><span>${title}</span><span class="marker" aria-hidden="true"></span></summary>
    <div class="branch-content">${renderContents(node, `${group}-${index}`)}</div>
  </details></li>`;
}

export const HOMEPAGE_CSS = `
:root {
  color-scheme: light;
  --paper: #f5f4ef;
  --node: #fbfaf6;
  --ink: #272b26;
  --muted: #596155;
  --line: #c8ccc1;
  --accent: #245638;
  --selected: #e7eddf;
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
a:focus-visible, summary:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
p, h1, h2 { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
button { font: inherit; color: inherit; cursor: pointer; }
code { font: inherit; overflow-wrap: anywhere; }
.page { max-width: 1240px; margin: 0 auto; padding: 0 40px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 24px 0; border-bottom: 1px solid var(--ink); }
.wordmark { font-size: 18px; font-weight: 600; text-decoration: none; letter-spacing: -0.5px; }
.edition { color: var(--muted); font-size: 12px; }
.tagline { margin: 32px 0 14px; color: var(--muted); font-size: 14px; }
h1 { font-size: clamp(26px, 4.5vw, 38px); line-height: 1.2; letter-spacing: -0.045em; font-weight: 500; margin-bottom: 28px; }
h2 { font-size: 16px; line-height: 1.5; font-weight: 500; }
.flow { position: relative; margin: 20px 0 28px; padding: 24px 0; }
.flow-start { position: relative; z-index: 1; background: var(--ink); color: var(--paper); padding: 22px 18px; border: 1px solid var(--ink); }
.flow-tasks, .flow-lines, .back-button { display: none; }
.flow-results { min-width: 0; }
.task-panel { min-width: 0; margin-top: 24px; }
.panel-title { margin-bottom: 16px; }
.flow.is-enhanced { display: grid; grid-template-columns: minmax(135px, .7fr) minmax(200px, 1fr) minmax(310px, 1.5fr); align-items: center; gap: 48px; }
.is-enhanced .flow-tasks { display: block; min-width: 0; }
.is-enhanced .flow-lines { display: block; position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; }
.flow-lines path { fill: none; stroke: var(--line); stroke-width: 1.25; vector-effect: non-scaling-stroke; }
.flow-lines path.active { stroke: var(--accent); stroke-width: 1.5; }
.flow-lines marker path { fill: var(--accent); stroke: none; }
.task-button { position: relative; z-index: 1; display: flex; justify-content: space-between; align-items: center; gap: 14px; width: 100%; min-height: 58px; padding: 14px 16px; border: 1px solid var(--line); background: var(--node); text-align: left; font-size: 13px; line-height: 1.5; }
.flow-tasks li + li { margin-top: 12px; }
.task-button:hover { border-color: var(--accent); }
.task-button.selected { border-color: var(--accent); background: var(--selected); color: var(--accent); }
.task-button.selected .task-arrow { font-weight: 700; }
.task-arrow { color: var(--accent); flex-shrink: 0; }
.is-enhanced .task-panel { margin: 0; }
.is-enhanced .panel-title { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); }
.branch { min-width: 0; }
.choices > li + li { margin-top: 14px; }
summary { position: relative; z-index: 1; display: flex; align-items: center; justify-content: space-between; gap: 16px; list-style: none; cursor: pointer; padding: 16px; min-height: 56px; border: 1px solid var(--line); background: var(--node); font-size: 13px; }
summary::-webkit-details-marker { display: none; }
summary:hover { border-color: var(--accent); }
.marker { width: 1ch; color: var(--accent); flex-shrink: 0; }
.marker::before { content: "+"; }
details[open] > summary { background: var(--selected); border-color: var(--accent); }
details[open] > summary .marker::before { content: "−"; }
.branch-content { margin: 20px 0 8px 4px; padding-left: 24px; border-left: 1px solid var(--line); }
.is-enhanced .branch-content { border-left-color: transparent; }
.destination { position: relative; z-index: 1; min-width: 0; border: 1px solid var(--line); background: var(--node); padding: 14px 16px; }
.destination:hover { border-color: var(--accent); }
.destination-link { display: flex; align-items: center; justify-content: space-between; gap: 14px; min-height: 30px; text-decoration: none; overflow-wrap: anywhere; }
.destination-link:hover .node-resource { text-decoration: underline; }
.node-label { display: grid; gap: 3px; }
.node-action { font-size: 11px; color: var(--muted); }
.node-resource { font-size: 14px; line-height: 1.5; }
.external-arrow { color: var(--accent); flex-shrink: 0; }
.source-link { font-size: 11px; min-height: 28px; display: inline-flex; align-items: center; margin-top: 4px; }
.note { color: var(--muted); font-size: 12px; }
.destination .note { margin-top: 8px; }
.reference { position: relative; z-index: 1; display: inline-block; background: var(--paper); margin: 4px 16px 12px 0; font-size: 12px; padding: 4px 0; }
.resource-panel { position: relative; z-index: 1; padding: 16px; font-size: 13px; border: 1px solid var(--line); background: var(--node); margin-bottom: 16px; }
.resource-panel p { margin-bottom: 14px; }
.resource-panel .access { font-size: 12px; color: var(--accent); }
.endpoint { display: block; font-size: 12px; margin: 10px 0 20px; }
table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 12px; }
caption { text-align: left; color: var(--muted); margin-bottom: 8px; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 8px 8px 8px 0; }
th { font-weight: 500; }
thead { color: var(--muted); }
.pin-routes th:first-child { width: 42%; }
.pin-routes td:last-child { white-space: nowrap; }
.example { margin: 12px 0; }
.example > summary { min-height: 44px; padding: 10px; font-size: 12px; }
.example > summary::after { content: "+"; color: var(--accent); }
.example[open] > summary::after { content: "−"; }
.example > p { margin-top: 14px; }
pre { margin: 12px 0 16px; padding: 12px; border: 1px solid var(--line); font: inherit; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
footer { display: flex; flex-wrap: wrap; gap: 8px 28px; padding: 24px 0; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
footer a { display: inline-flex; align-items: center; min-height: 32px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 20px; top: -100px; padding: 10px; background: var(--paper); z-index: 3; }
.skip-link:focus { top: 8px; }
@media (max-width: 1000px) and (min-width: 761px) {
  .page { padding: 0 28px; }
  .flow.is-enhanced { grid-template-columns: 130px minmax(165px, .8fr) minmax(260px, 1.3fr); gap: 32px; }
  .flow-start { padding: 18px 12px; }
  .flow-start h2 { font-size: 14px; }
  .task-button { padding: 12px; font-size: 12px; }
}
@media (max-width: 760px) {
  .page { padding: 0 20px; }
  header { padding: 20px 0; }
  .wordmark { font-size: 16px; }
  .tagline { font-size: 12px; margin: 24px 0 14px; }
  h1 { margin-bottom: 20px; }
  .flow.is-enhanced { display: block; padding: 16px; }
  .flow-start { max-width: 260px; margin: 0 auto 32px; padding: 16px; text-align: center; }
  .flow-start h2 { font-size: 15px; }
  .task-button { min-height: 48px; padding: 12px; }
  .flow-tasks li + li { margin-top: 10px; }
  .flow-results { margin-top: 42px; }
  .is-enhanced .panel-title { position: static; width: auto; height: auto; margin: 0 0 14px; overflow: visible; clip-path: none; font-size: 17px; }
  .is-enhanced .back-button { display: inline-block; position: relative; z-index: 1; padding: 8px 0; margin: 0 0 12px; border: 0; background: var(--paper); font-size: 11px; text-align: left; }
  .branch-content { padding-left: 20px; margin-left: 0; }
  .destination, .resource-panel { padding: 12px; }
  .node-resource { font-size: 13px; }
  summary { padding: 12px; }
  table, .endpoint, pre { font-size: 11px; }
  .pin-routes th:first-child { width: 38%; }
  .pin-routes th, .pin-routes td { overflow-wrap: anywhere; padding-right: 4px; }
  .pin-routes td:last-child { white-space: normal; }
}
@media print {
  :root { background: white; color: black; }
  .page { max-width: none; padding: 0; }
  .skip-link, .flow-lines, .flow-tasks, .back-button { display: none !important; }
  .flow.is-enhanced { display: block; }
  .task-panel[hidden] { display: block !important; }
  .is-enhanced .panel-title { position: static; width: auto; height: auto; clip-path: none; margin: 20px 0; }
  .branch, .destination { break-inside: avoid; }
}
`;

export const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The pay and cash out functions of the open internet. Find Juicebox apps, contracts, RPC and IPFS APIs, skills, and audit resources.">
  <script defer src="${HOMEPAGE_JS_PATH}?v=${createHash("sha256").update(HOMEPAGE_JS).digest("hex").slice(0, 12)}"></script>
  <meta name="theme-color" content="#f5f4ef">
  <title>Juicebox Center</title>
  <link rel="canonical" href="https://juicebox.center/">
  <link rel="stylesheet" href="${HOMEPAGE_CSS_PATH}?v=${createHash("sha256").update(HOMEPAGE_CSS).digest("hex").slice(0, 12)}">
</head>
<body>
  <a class="skip-link" href="#main">Skip to directory</a>
  <div class="page">
    <header>
      <a class="wordmark" href="/">juicebox.center</a>
      <span class="edition">V6</span>
    </header>
    <main id="main">
      <p class="tagline">The &quot;pay&quot; and &quot;cash out&quot; functions of the open internet.</p>
      <h1>Everything Juicebox in one place</h1>
      <section class="flow" aria-label="Juicebox resource map">
        <svg class="flow-lines" aria-hidden="true" focusable="false"></svg>
        <div class="flow-start"><h2>What do you want to do?</h2></div>
        <nav class="flow-tasks" aria-label="Choose a task">
          <ul>${directoryTree.map((node) => `<li><button type="button" class="task-button" id="task-${node.id}" data-task="${node.id}" aria-controls="panel-${node.id}" aria-expanded="false"><span>${escapeHtml(node.title)}</span><span class="task-arrow" aria-hidden="true">→</span></button></li>`).join("")}</ul>
        </nav>
        <div class="flow-results">
          ${directoryTree
            .map(
              (
                node,
                index,
              ) => `<section class="task-panel" id="panel-${node.id}" data-task="${node.id}" aria-labelledby="title-${node.id}">
            <button type="button" class="back-button" data-back>← Choose another task</button>
            <h2 class="panel-title" id="title-${node.id}" tabindex="-1">${escapeHtml(node.title)}</h2>
            ${renderContents(node, `group-${index}`)}
          </section>`,
            )
            .join("")}
        </div>
      </section>
    </main>
    <footer>
      <a href="https://github.com/mejango/jbcenter/blob/main/src/directory.ts">Improve this directory ↗</a>
      <a href="https://github.com/Bananapus/version-6/issues">Ecosystem issues ↗</a>
    </footer>
  </div>
</body>
</html>`;
