import { journeys, repositoryGroups, type DirectoryLink } from "./directory.js";

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

function renderLink(link: DirectoryLink, heading: "h3" | "h4"): string {
  return `<li class="entry">
    <${heading}><a class="entry-link" href="${escapeHtml(link.url)}">${escapeHtml(link.title)}<span class="arrow" aria-hidden="true">↗</span></a></${heading}>
    <p>${escapeHtml(link.description)}</p>
    ${link.sourceUrl ? `<a class="source-link" href="${escapeHtml(link.sourceUrl)}">Source<span class="visually-hidden"> for ${escapeHtml(link.title)}</span> ↗</a>` : ""}
    ${link.label ? `<span class="entry-label">${escapeHtml(link.label)} repository</span>` : ""}
  </li>`;
}

export const HOMEPAGE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="A directory for Juicebox V6. Find apps, launch a project, build integrations, connect an AI agent, and explore contracts and audit resources.">
  <meta name="theme-color" content="#f5f4ef">
  <title>Juicebox Center — ecosystem directory</title>
  <link rel="canonical" href="https://juicebox.center/">
  <link rel="stylesheet" href="${HOMEPAGE_CSS_PATH}">
</head>
<body>
  <a class="skip-link" href="#main">Skip to directory</a>
  <div class="page">
    <header class="masthead">
      <a class="wordmark" href="/" aria-label="Juicebox Center home">juicebox.center</a>
      <span class="edition">Juicebox / V6</span>
    </header>
    <main id="main">
      <div class="intro">
        <p class="eyebrow">An open ecosystem. Many ways in.</p>
        <h1>Find your way<br>through Juicebox.</h1>
        <p class="lede">Apps, contracts, and resources for funding projects and building on Juicebox. Pick up wherever you are.</p>
        <p class="scope">This directory focuses on V6. Apps may also list earlier versions; check the project version when using V6 guides.</p>
      </div>
      <nav class="jump-nav" aria-label="Directory sections">
        <a href="#apps">Apps</a>
        <a href="#projects">Project owners</a>
        <a href="#developers">Developers</a>
        <a href="#auditors">Auditors</a>
        <a href="#agents">AI agents</a>
        <a href="#repositories">All repositories <span aria-hidden="true">↓</span></a>
      </nav>
      ${journeys
        .map(
          (
            section,
          ) => `<section class="journey" id="${section.id}" aria-labelledby="${section.id}-title">
        <div class="section-intro">
          <p class="eyebrow"><span class="section-number">${section.number}</span> ${escapeHtml(section.audience)}</p>
          <h2 id="${section.id}-title">${escapeHtml(section.title)}</h2>
          <p>${escapeHtml(section.description)}</p>
          ${section.id === "developers" ? '<a class="section-link" href="#repositories">Browse all source repositories ↓</a>' : ""}
          ${section.id === "agents" ? '<p class="endpoint-label">MCP endpoint</p><code class="endpoint">https://juicebox.center/mcp</code>' : ""}
        </div>
        <ul class="link-grid">${section.links.map((link) => renderLink(link, "h3")).join("")}</ul>
      </section>`,
        )
        .join("")}
      <section class="repositories" id="repositories" aria-labelledby="repositories-title">
        <div class="repository-heading">
          <div>
            <p class="eyebrow"><span class="section-number">06</span> The source, by purpose</p>
            <h2 id="repositories-title">Repository index</h2>
          </div>
          <p>Start with the <a href="https://github.com/Bananapus/version-6">V6 top-level repository ↗</a> for the workspace and documentation. Explore individual components below.</p>
        </div>
        <div class="repository-grid">${repositoryGroups
          .map(
            (
              group,
              index,
            ) => `<section class="repository-group" aria-labelledby="repo-${index}">
          <h3 id="repo-${index}">${escapeHtml(group.title)}</h3>
          <ul>${group.links.map((link) => renderLink(link, "h4")).join("")}</ul>
        </section>`,
          )
          .join("")}</div>
      </section>
    </main>
    <footer>
      <p>Juicebox is a protocol. Choose your interface.</p>
      <div>
        <a href="https://github.com/mejango/jbcenter/blob/main/src/directory.ts">Improve this directory ↗</a>
        <a href="https://github.com/Bananapus/version-6/issues">Ecosystem issues ↗</a>
        <a href="#main">Back to top ↑</a>
      </div>
    </footer>
  </div>
</body>
</html>`;

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
a:hover { color: var(--accent); }
a:focus-visible { outline: 2px solid var(--accent); outline-offset: 5px; }
p, h1, h2, h3, h4 { margin: 0; }
h1, h2, h3, h4 { font-weight: 500; }
ul { list-style: none; margin: 0; padding: 0; }
code { font: inherit; }
.page { max-width: 1280px; margin: 0 auto; padding: 0 clamp(20px, 4.5vw, 64px); }
.masthead { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 26px 0; border-bottom: 1px solid var(--ink); }
.wordmark { font-size: 18px; font-weight: 600; text-decoration: none; letter-spacing: -0.5px; }
.edition, .eyebrow, .source-link, .entry-label, .endpoint-label { font-size: 12px; }
.edition { color: var(--muted); }
.intro { padding: 66px 0 40px; }
.eyebrow { color: var(--muted); }
h1 { font-size: clamp(32px, 4.8vw, 58px); line-height: 1.13; letter-spacing: -0.055em; margin: 18px 0 24px; }
.lede { font-size: 16px; max-width: 660px; }
.scope { max-width: 680px; font-size: 12px; color: var(--muted); margin-top: 22px; }
.jump-nav { display: flex; flex-wrap: wrap; column-gap: 30px; padding: 8px 0; border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
.jump-nav a { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; text-decoration: none; }
.jump-nav a:hover { text-decoration: underline; }
.journey { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 48px; padding: 46px 0 32px; border-bottom: 1px solid var(--line); scroll-margin-top: 24px; }
.section-number { color: var(--accent); margin-right: 8px; }
h2 { font-size: 23px; line-height: 1.3; letter-spacing: -0.04em; margin-top: 12px; }
.section-intro > p:not(.eyebrow):not(.endpoint-label) { margin-top: 16px; color: var(--muted); max-width: 32ch; }
.section-link { display: inline-block; margin-top: 20px; font-size: 12px; }
.link-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 32px; }
.entry { min-width: 0; padding: 15px 0 20px; border-top: 1px solid var(--line); }
.entry-link { display: flex; justify-content: space-between; gap: 12px; font-size: 15px; line-height: 1.4; padding: 3px 0; text-decoration: none; }
.entry-link:hover { text-decoration: underline; }
.arrow { color: var(--accent); font-size: 16px; flex-shrink: 0; }
.entry p { color: var(--muted); font-size: 12px; line-height: 1.7; margin-top: 8px; }
.source-link, .entry-label { display: inline-block; margin-top: 8px; }
.entry-label { color: var(--muted); }
.endpoint-label { color: var(--muted); margin-top: 22px; }
.endpoint { display: block; margin-top: 5px; font-size: 12px; overflow-wrap: anywhere; }
.repositories { padding: 46px 0 30px; scroll-margin-top: 24px; }
.repository-heading { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 48px; align-items: end; margin-bottom: 36px; }
.repository-heading > p { color: var(--muted); max-width: 68ch; font-size: 13px; }
.repository-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 32px; }
.repository-group > h3 { font-size: 13px; font-weight: 600; margin-bottom: 16px; }
.repository-group .entry-link { font-size: 14px; }
footer { padding: 26px 0 36px; border-top: 1px solid var(--ink); color: var(--muted); font-size: 12px; }
footer > div { display: flex; flex-wrap: wrap; gap: 8px 28px; margin-top: 12px; }
footer a { display: inline-flex; align-items: center; min-height: 36px; }
.visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
.skip-link { position: absolute; left: 20px; top: -100px; padding: 10px; background: var(--paper); z-index: 1; }
.skip-link:focus { top: 8px; }
@media (max-width: 960px) {
  .journey, .repository-heading { grid-template-columns: minmax(0, 1fr); gap: 28px; }
  .section-intro > p:not(.eyebrow):not(.endpoint-label) { max-width: 60ch; }
  .repository-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 560px) {
  .masthead { flex-wrap: wrap; padding: 20px 0; }
  .wordmark { font-size: 16px; }
  .edition { font-size: 11px; }
  .intro { padding: 40px 0 28px; }
  .lede { font-size: 14px; }
  .jump-nav { column-gap: 24px; }
  .jump-nav a { font-size: 12px; }
  .journey { padding: 32px 0 16px; }
  .link-grid, .repository-grid { grid-template-columns: minmax(0, 1fr); }
  .entry-link { min-height: 36px; align-items: center; }
  .entry { padding: 12px 0 18px; }
  .entry p { margin-top: 4px; }
  .source-link { padding: 4px 0; }
  .repositories { padding-top: 32px; }
  .repository-heading { margin-bottom: 28px; gap: 20px; }
  .repository-grid { gap: 24px; }
}
@media print {
  :root { background: white; color: black; }
  .page { max-width: none; padding: 0; }
  .skip-link, .jump-nav, .arrow { display: none; }
  .intro { padding: 24px 0; }
  .entry { break-inside: avoid; }
  a { text-decoration: underline; }
}
`;
