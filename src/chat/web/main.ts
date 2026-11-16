import type { ChatMessage } from "../provider.js";
import type { Source } from "../sources.js";
import { readEvents } from "./events.js";
import { STORAGE_KEY } from "./key.js";
import { renderAnswer, type Cited } from "./render.js";

const chat = document.getElementById("chat")!;
const form = chat.querySelector("form")!;
const input = form.querySelector("textarea")!;
const log = document.createElement("div");
const fresh = document.createElement("button");

let messages: ChatMessage[] = [];
let sources: Source[] = [];
let request: AbortController | undefined;
let started = false;

const element = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
};

/** One answer: its text with numbered links, then the sources it cited, in citation order. */
function answer(node: HTMLElement, text: string): void {
  const cited = new Map<string, Cited>();
  node.innerHTML = renderAnswer(text, (id) => {
    const source = sources.find((candidate) => candidate.id === id);
    if (source && !cited.has(id)) cited.set(id, { n: cited.size + 1, url: source.url, title: source.title });
    return cited.get(id);
  });
  if (cited.size === 0) return;
  const list = node.appendChild(element("ol", "cited"));
  for (const { n, url, title } of cited.values()) {
    if (!/^https?:\/\//.test(url)) continue;
    const link = list.appendChild(element("li", "", `[${n}] `)).appendChild(element("a", "", title));
    link.href = url;
    link.rel = "noopener";
  }
}

function show(): void {
  log.replaceChildren(...messages.map(({ role, text }) => {
    const node = element("div", role === "user" ? "you" : "answer", role === "user" ? text : "");
    if (role === "assistant") answer(node, text);
    return node;
  }));
  const talking = messages.length > 0;
  fresh.hidden = !talking;
  chat.querySelector<HTMLElement>(".jumps")!.hidden = talking;
}

function save(): void {
  try {
    if (messages.length === 0) return localStorage.removeItem(STORAGE_KEY);
    // Only the sources a kept answer cites.
    const kept = sources.filter(({ id }) => messages.some(({ text }) => text.includes(`[${id}]`)));
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ messages, sources: kept }));
  } catch {}
}

function restore(): void {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (stored === null) return;
    const text = (value: unknown) => typeof value === "string";
    if (!stored.messages.every((message: ChatMessage) => ["user", "assistant"].includes(message.role) && text(message.text))
      || !stored.sources.every((source: Source) => text(source.id) && text(source.title) && text(source.url))) throw new Error();
    ({ messages, sources } = stored);
  } catch {
    // Unreadable or from another shape: start clean.
    try { localStorage.removeItem(STORAGE_KEY); } catch {}
  }
}

function busy(on: boolean): void {
  chat.ariaBusy = String(on);
  form.querySelector("button")!.disabled = on;
}

const notice = (text: string, action?: string) => {
  const node = log.appendChild(element("p", "notice", text));
  if (action) node.appendChild(element("button", "", action)).dataset.retry = "";
};

/** Sends the conversation, which ends with the visitor's turn, and streams the answer in. */
async function send(dropped = 0): Promise<void> {
  const mine = (request = new AbortController());
  busy(true);
  const status = log.appendChild(element("p", "status", "Thinking"));
  const node = element("div", "answer");
  let text = "", reason: string | undefined;
  try {
    const response = await fetch("/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }), signal: mine.signal });
    if (response.status === 413 && dropped < 3 && messages.length > 2) {
      status.remove();
      messages = messages.slice(2);
      show();
      notice("Earlier messages were dropped to fit.");
      return await send(dropped + 1);
    }
    if (response.status === 503) chat.hidden = true;
    if (response.status === 429) reason = "resting";
    else if (response.ok) for await (const event of readEvents(response)) {
      if (event.type === "tool") status.textContent = event.label;
      else if (event.type === "source") sources = [...sources.filter(({ id }) => id !== event.source.id), event.source];
      else if (event.type === "done") reason = event.reason;
      else if (event.type === "text") {
        if (!text) status.replaceWith(node);
        answer(node, text += event.text);
      }
    }
  } catch {}
  if (mine !== request) return;
  status.remove();
  busy(false);
  if (reason === "refusal" && !text) text = "I can't help with that.";
  if (reason === "resting") return notice("Chat is resting. The directory is below.");
  // A failed answer keeps what arrived on screen, and is not kept in the conversation.
  if (!text || !reason || reason === "error") return notice("That did not work.", "Try again");
  messages.push({ role: "assistant", text });
  save();
  show();
  if (reason === "rounds" || reason === "max_tokens") notice("That answer was cut short.");
}

function ask(text: string): void {
  if (!text.trim() || chat.ariaBusy === "true") return;
  // A question that got no answer is replaced by the next one.
  if (messages.at(-1)?.role === "user") messages.pop();
  messages.push({ role: "user", text: text.trim() });
  // Typed since asking: leave it.
  if (input.value === text) input.value = "";
  save();
  show();
  void send();
}

function start(): void {
  started = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = chat.dataset.css!;
  document.head.append(link);
  log.id = "log";
  log.setAttribute("aria-live", "polite");
  fresh.textContent = "New chat";
  fresh.dataset.new = "";
  fresh.type = "button";
  input.maxLength = 8000;
  form.before(log);
  form.append(fresh);
  form.after(element("p", "hint", "Answers come from an AI model. Check the sources."));
  input.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    form.requestSubmit();
  });
  restore();
  show();
  // A reload mid-answer leaves a question without one.
  if (messages.at(-1)?.role === "user") notice("That did not work.", "Try again");
}

/** Every event in the chat section arrives here, from the boot script. */
export function on(event?: Event, asked = ""): void {
  if (!started) start();
  const button = event?.type === "click" ? (event.target as Element).closest("button") : null;
  if (event?.type === "submit") ask(asked);
  else if (button?.parentElement?.className === "jumps") ask(button.textContent!);
  else if (button && "retry" in button.dataset && chat.ariaBusy !== "true") {
    show();
    void send();
  } else if (button === fresh) {
    request?.abort();
    request = undefined;
    messages = [];
    sources = [];
    busy(false);
    save();
    show();
    input.focus();
  }
}
