/** What the form needs on first view. Appended to the directory stylesheet when chat is on. */
export const CHAT_FIRST_VIEW_CSS = `textarea, button { border: 1px solid var(--line); background: none; font: inherit; color: inherit; }
textarea { width: 100%; margin: 12px 0 8px; padding: 12px; }
button { padding: 6px 12px; font-size: 12px; }
`;

/** The conversation, loaded with the chat bundle. */
export const CHAT_CSS = `textarea { resize: vertical; border-radius: 0; }
button { border-radius: 0; cursor: pointer; }
#chat [hidden] { display: none; }
#chat button:hover { border-color: var(--accent); color: var(--accent); }
#chat button:disabled { color: var(--muted); border-color: var(--line); cursor: default; }
#chat :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
#log { max-width: 80ch; }
#log > * { margin-top: 16px; }
#log .you { padding-top: 12px; border-top: 1px solid var(--line); font-weight: 600; overflow-wrap: anywhere; }
#log .answer > * + * { margin-top: 8px; }
#log .answer a { color: var(--accent); text-decoration: underline; text-underline-offset: 4px; }
#log ul, #log ol { padding-left: 20px; }
#log ul { list-style: disc; }
#log .answer ol:not(.cited) { list-style: decimal; }
#log :not(pre) > code { color: var(--accent); }
#log pre { overflow-x: auto; padding: 12px; border: 1px solid var(--line); }
#log .cited { padding: 0; list-style: none; color: var(--muted); font-size: 12px; }
#log .cited a { overflow-wrap: anywhere; }
#log .status, #log .notice { color: var(--muted); font-size: 12px; }
#log .notice button { margin-left: 8px; }
#chat [data-new] { margin-left: 8px; }
#chat .hint { margin-top: 8px; color: var(--muted); font-size: 11px; }
#chat .jumps a:hover { border-color: var(--accent); color: var(--accent); }
body:not(.talking) #log { display: none; }
body.talking main, body.talking footer, body.talking .skip-link, body.talking #chat h1 { display: none; }
body.talking .page, body.talking #chat { display: flex; flex-direction: column; }
body.talking .page { min-height: 100dvh; }
body.talking #chat, body.talking #log { flex: 1; }
body.talking #log { width: 100%; margin: 0 auto; padding-bottom: 16px; }
body.talking #chat form { position: sticky; bottom: 0; width: 100%; max-width: 80ch; margin: 0 auto; padding-bottom: 12px; background: var(--paper); border-top: 1px solid var(--line); }
`;
