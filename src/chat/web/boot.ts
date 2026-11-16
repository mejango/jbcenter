import { STORAGE_KEY } from "./key.js";

// The first view pays for this file only: the chat itself loads on first use.
const chat = document.getElementById("chat")!;
let main: Promise<{ on(event?: Event, asked?: string): void }> | undefined;
const on = (event?: Event) => {
  if (event?.type === "submit") event.preventDefault();
  // What was in the box at this moment: the chat may still be loading when it gets the event.
  const asked = (event?.target as { 0?: { value?: string } } | undefined)?.[0]?.value;
  (main ??= import(chat.dataset.src!)).then((module) => module.on(event, asked), () => { main = undefined; });
};
for (const type of ["focusin", "click", "submit"]) chat.addEventListener(type, on);
chat.hidden = false;
try {
  if (localStorage.getItem(STORAGE_KEY)) on();
} catch {}
