import { createHash } from "node:crypto";
import {
  directoryTree,
  repositoryGroups,
  type DirectoryNode,
} from "./directory.js";

export const HOMEPAGE_CSS_PATH = "/directory.css";
export const HOMEPAGE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
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
  rpc: `<div class="resource-panel">
    <p class="access">Public · no API key</p>
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
  ipfs: `<div class="resource-panel">
    <p class="access">Public · no API key</p>
    <code class="endpoint">GET https://juicebox.center/ipfs/:cid[/path]</code>
    <p><code>ipfs://CID/image.png</code> becomes:</p>
    <code class="endpoint">https://juicebox.center/ipfs/CID/image.png</code>
    <p class="note">Cross-origin reads and media byte ranges. Up to 500 MiB. HTML, scripts, CSS, XML, PDFs, and Wasm download as files.</p>
    <a class="reference" href="https://github.com/mejango/jbcenter#pin-and-read-ipfs-content">Gateway documentation ↗</a>
  </div>`,
  pinning: `<div class="resource-panel">
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
  mcp: `<div class="resource-panel">
    <p class="access">Streamable HTTP · any compatible agent</p>
    <code class="endpoint">https://juicebox.center/mcp</code>
  </div>`,
};

function renderNode(node: DirectoryNode, group: string, index: number): string {
  const title = escapeHtml(node.title);
  if (node.url) {
    return `<li class="destination">
      <a class="destination-link" href="${escapeHtml(node.url)}">${title}<span aria-hidden="true">↗</span></a>
      ${node.sourceUrl ? `<a class="source-link" href="${escapeHtml(node.sourceUrl)}">Source<span class="visually-hidden">: ${title}</span></a>` : ""}
      ${node.note ? `<p class="note">${escapeHtml(node.note)}</p>` : ""}
    </li>`;
  }
  const nextGroup = `${group}-${index}`;
  const children =
    node.content === "repositories"
      ? repositoryGroups.map((category) => ({
          title: category.title,
          children: category.links.map(({ title, url }) => ({ title, url })),
        }))
      : node.children;
  const content =
    node.content && node.content !== "repositories"
      ? API_CONTENT[node.content]
      : "";
  return `<li class="branch"><details${node.id ? ` id="${escapeHtml(node.id)}"` : ""} name="${group}">
    <summary><span>${title}</span><span class="marker" aria-hidden="true"></span></summary>
    <div class="branch-content">
      ${content}
      ${node.content === "repositories" ? '<a class="reference" href="https://github.com/Bananapus/version-6">Start with the V6 top-level repository ↗</a>' : ""}
      ${children ? `<ul class="choices">${children.map((child, childIndex) => renderNode(child, nextGroup, childIndex)).join("")}</ul>` : ""}
    </div>
  </details></li>`;
}

export const HOMEPAGE_CSS = `
:root {
  color-scheme: light;
  --paper: #f5f4ef;
  --ink: #272b26;
  --muted: #596155;
  --line: #c8ccc1;
  --accent: #245638;
  font-family: ui-monospace, "SFMono-Regular", Consolas, "Liberation Mono", monospace;
  color: var(--ink);
  background: var(--paper);
  font-synthesis: none;
  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}
* { box-sizing: border-box; }
body { margin: 0; font-size: 14px; line-height: 1.65; }
a { color: inherit; text-underline-offset: 4px; text-decoration-thickness: 1px; }
a:hover, summary:hover { color: var(--accent); }
a:focus-visible, summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
p, h1 { margin: 0; }
ul { list-style: none; margin: 0; padding: 0; }
code { font: inherit; overflow-wrap: anywhere; }
.page { max-width: 900px; margin: 0 auto; padding: 0 32px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 24px 0; border-bottom: 1px solid var(--ink); }
.wordmark { font-size: 18px; font-weight: 600; text-decoration: none; letter-spacing: -0.5px; }
.edition { color: var(--muted); font-size: 12px; }
.tagline { margin: 32px 0 28px; color: var(--muted); font-size: 14px; }
h1 { font-size: 24px; line-height: 1.4; letter-spacing: -0.04em; font-weight: 500; margin-bottom: 20px; }
.branch { min-width: 0; }
.decision-tree > .branch { border-top: 1px solid var(--line); }
.decision-tree > .branch:last-child { border-bottom: 1px solid var(--line); }
summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; list-style: none; cursor: pointer; padding: 14px 0; min-height: 48px; }
summary::-webkit-details-marker { display: none; }
.decision-tree > .branch > details > summary { font-size: 17px; }
.marker { width: 1ch; color: var(--accent); flex-shrink: 0; }
.marker::before { content: "+"; }
details[open] > summary .marker::before { content: "−"; }
.branch-content { margin: 0 0 20px 4px; padding-left: 24px; border-left: 1px solid var(--line); }
.choices > li + li { border-top: 1px solid var(--line); }
.destination { display: flex; align-items: baseline; flex-wrap: wrap; gap: 0 16px; padding: 4px 0; min-width: 0; }
.destination-link { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; flex: 1 1 240px; padding: 10px 0; text-decoration: none; overflow-wrap: anywhere; }
.destination-link:hover { text-decoration: underline; }
.destination-link > span { color: var(--accent); flex-shrink: 0; }
.source-link { font-size: 11px; min-height: 28px; display: inline-flex; align-items: center; }
.note { color: var(--muted); font-size: 12px; }
.destination .note { width: 100%; margin-bottom: 10px; }
.reference { display: inline-block; margin: 4px 20px 12px 0; font-size: 12px; padding: 4px 0; }
.resource-panel { padding: 4px 0 12px; font-size: 13px; }
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
.example { border-top: 1px solid var(--line); margin: 12px 0; }
.example > summary { font-size: 12px; }
.example > summary::after { content: "+"; color: var(--accent); }
.example[open] > summary::after { content: "−"; }
pre { margin: 0 0 16px; padding: 14px; border: 1px solid var(--line); font: inherit; font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
footer { display: flex; flex-wrap: wrap; gap: 8px 28px; padding: 28px 0; color: var(--muted); font-size: 11px; }
footer a { display: inline-flex; align-items: center; min-height: 32px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 20px; top: -100px; padding: 10px; background: var(--paper); z-index: 1; }
.skip-link:focus { top: 8px; }
@media (max-width: 560px) {
  .page { padding: 0 20px; }
  header { padding: 20px 0; }
  .wordmark { font-size: 16px; }
  .tagline { font-size: 12px; margin: 24px 0; }
  h1 { font-size: 21px; }
  .decision-tree > .branch > details > summary { font-size: 15px; }
  .branch-content { margin-left: 0; padding-left: 14px; }
  .destination-link { font-size: 13px; flex-basis: 190px; }
  .choices summary { font-size: 13px; }
  table, .endpoint, pre { font-size: 11px; }
  .pin-routes th:first-child { width: 40%; }
}
@media print {
  :root { background: white; color: black; }
  .page { max-width: none; padding: 0; }
  .skip-link { display: none; }
  .branch, .destination { break-inside: avoid; }
}
`;

export const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The pay and cash out functions of the open internet. Find Juicebox apps, contracts, RPC and IPFS APIs, skills, and audit resources.">
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
      <h1>What do you want to do?</h1>
      <nav aria-label="Choose a task">
        <ul class="decision-tree">${directoryTree.map((node, index) => renderNode(node, "directory", index)).join("")}</ul>
      </nav>
    </main>
    <footer>
      <a href="https://github.com/mejango/jbcenter/blob/main/src/directory.ts">Improve this directory ↗</a>
      <a href="https://github.com/Bananapus/version-6/issues">Ecosystem issues ↗</a>
    </footer>
  </div>
</body>
</html>`;
