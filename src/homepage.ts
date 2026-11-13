import { assetHref, hashedAssetName } from "./rest/web/assets.js";
import { BRAND_CSS, BRAND_ICON, FAVICON_LINK, FAVICON_SVG } from "./branding.js";
import {
  auditLinks,
  directorySections,
  repositoryGroupId,
  repositoryGroups,
  V6_REPOSITORY,
  workInProgress,
  type DirectoryLink,
} from "./directory.js";

export const HOMEPAGE_HEADERS = {
  "Cache-Control": "public, max-age=300",
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  // `/` answers `Accept: text/markdown` with the same directory as text.
  Vary: "Accept",
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

const external = (url: string) => /^https?:/.test(url);

function renderLink({ need, name, url, note, code }: DirectoryLink): string {
  return `<li><a href="${escapeHtml(url)}"><span class="need">${escapeHtml(need)}</span><span class="name">${escapeHtml(name)}${external(url) ? ' <span aria-hidden="true">↗</span>' : ""}</span></a>${
    code || note ? `<p class="note">${code ? `<code>${escapeHtml(code)}</code>` : ""}${code && note ? " " : ""}${note ? escapeHtml(note) : ""}</p>` : ""
  }</li>`;
}

const group = (title: string, links: readonly DirectoryLink[], id?: string) =>
  `<div class="group"><h3${id ? ` id="${id}"` : ""}>${escapeHtml(title)}</h3><ul class="rows">${links.map(renderLink).join("")}</ul></div>`;

const jumps = [
  ...directorySections.map(({ id, title }) => [id, title]),
  ["auditors", "Audit"],
  ["repositories", "Source"],
];

export const HOMEPAGE_CSS = `
${BRAND_CSS}
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
  scroll-behavior: smooth;
}
* { box-sizing: border-box; }
body { margin: 0; font-size: 13px; line-height: 1.5; }
a { color: inherit; text-decoration: none; }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
p, h1, h2, h3 { margin: 0; font-weight: 500; }
ul { list-style: none; margin: 0; padding: 0; }
code { font: inherit; overflow-wrap: anywhere; }
.page { max-width: 1320px; margin: 0 auto; padding: 0 40px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 20px 0; border-bottom: 1px solid var(--ink); }
.wordmark { font-size: 18px; font-weight: 600; letter-spacing: -0.5px; }
.edition { color: var(--muted); font-size: 12px; }
h1 { font-size: clamp(24px, 4vw, 34px); line-height: 1.2; letter-spacing: -0.045em; margin: 28px 0 8px; }
.introduction { color: var(--muted); }
.introduction a, footer a { text-decoration: underline; text-underline-offset: 4px; }
.jumps { display: flex; flex-wrap: wrap; gap: 8px; margin: 20px 0 8px; }
.jumps a { padding: 6px 12px; border: 1px solid var(--line); font-size: 12px; }
.jumps a:hover { border-color: var(--accent); color: var(--accent); }
.audiences { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 48px; margin-top: 20px; }
section { scroll-margin-top: 8px; padding-top: 12px; }
section:target > h2, h3:target { color: var(--accent); }
h2 { font-size: 22px; letter-spacing: -0.03em; }
.audience { color: var(--muted); font-size: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--ink); }
h3 { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding: 24px 0 6px; scroll-margin-top: 8px; }
.group { break-inside: avoid; }
.rows li { border-top: 1px solid var(--line); }
.rows a { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding: 9px 0; }
.name { color: var(--accent); text-align: right; flex-shrink: 0; }
.rows a:hover .need { color: var(--accent); }
.rows a:hover .name { text-decoration: underline; text-underline-offset: 4px; }
.note { color: var(--muted); font-size: 11px; margin: -6px 0 9px; }
.note code { color: var(--ink); }
.more { margin-top: 56px; padding-top: 12px; border-top: 1px solid var(--ink); }
.more .groups { columns: 3 280px; column-gap: 48px; }
.all { color: var(--accent); font-size: 12px; }
.all:hover { text-decoration: underline; text-underline-offset: 4px; }
footer { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 40px; padding: 20px 0 32px; border-top: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.skip-link { position: absolute; left: 20px; top: -100px; padding: 10px; background: var(--paper); }
.skip-link:focus { top: 8px; }
@media (max-width: 900px) {
  .audiences { grid-template-columns: 1fr; }
  section + section { margin-top: 32px; }
}
@media (max-width: 760px) {
  .page { padding: 0 16px; }
  .wordmark { font-size: 16px; }
  .rows a { padding: 13px 0; }
}
@media (prefers-reduced-motion: reduce) { :root { scroll-behavior: auto; } }
`;

/** The files \`/\` links, served under hashed names: its stylesheet and icon. */
export const homepageAssets = (): Record<string, string> => ({
  "directory.css": HOMEPAGE_CSS, "favicon.svg": FAVICON_SVG,
});
const names = Object.fromEntries(Object.entries(homepageAssets()).map(([file, body]) => [file, hashedAssetName(file, body)]));

export const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="The directory for Juicebox V6: apps, guides, APIs, agent tools, audits, and source.">
  <meta name="theme-color" content="#f5f4ef">
  <title>Juicebox Center</title>
  ${FAVICON_LINK}
  <link rel="canonical" href="https://juicebox.center/">
  <link rel="alternate" type="text/markdown" href="/llms.txt" title="This directory as text">
  <link rel="stylesheet" href="${assetHref("", "directory.css", names)}">
</head>
<body>
  <a class="skip-link" href="#main">Skip to directory</a>
  <div class="page">
    <header>
      <a class="wordmark" href="/">${BRAND_ICON} juicebox.center</a>
      <span class="edition">V6</span>
    </header>
    <main id="main" tabindex="-1">
      <h1>Everything Juicebox in one place</h1>
      <p class="introduction">The 'pay' and 'cash out' functions of the open internet. New here? <a href="https://juicebox.money/learn">Start with the basics</a>.</p>
      <nav class="jumps" aria-label="Sections">${jumps.map(([id, title]) => `<a href="#${id}">${escapeHtml(title!)}</a>`).join("")}</nav>
      <div class="audiences">${directorySections.map(({ id, title, audience, groups }) => `<section id="${id}" aria-labelledby="title-${id}"><h2 id="title-${id}">${escapeHtml(title)}</h2><p class="audience">${escapeHtml(audience)}</p>${groups.map((item) => group(item.title, item.links, item.id)).join("")}</section>`).join("")}</div>
      <section class="more" id="repositories" aria-labelledby="title-repositories">
        <h2 id="title-repositories">Source and audit</h2>
        <p class="audience"><a class="all" href="${V6_REPOSITORY}">All of V6 in one repository <span aria-hidden="true">↗</span></a></p>
        <div class="groups">
          ${group("Audit", auditLinks, "auditors")}
          ${repositoryGroups.map((item) => `<div class="group"><h3 id="${repositoryGroupId(item.title)}">${escapeHtml(item.title)}</h3><ul class="rows">${item.links.map((link) => `<li><a href="${escapeHtml(link.url)}"><span class="need">${escapeHtml(link.title)}</span><span class="name" aria-hidden="true">↗</span></a></li>`).join("")}</ul></div>`).join("")}
          ${group("Unfinished", workInProgress, "wip")}
        </div>
      </section>
    </main>
    <footer>
      <a href="/llms.txt">Agents: read /llms.txt</a>
      <a href="https://github.com/mejango/jbcenter/blob/main/src/directory.ts">Improve this directory ↗</a>
      <a href="https://github.com/Bananapus/version-6/issues">Report an issue ↗</a>
    </footer>
  </div>
</body>
</html>`;
