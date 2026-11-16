import { STORAGE_KEY } from "./key.js";

// The first view pays for this file only: the chat itself loads on first use.
const chat = document.getElementById("chat")!;
let main: Promise<{ on(event?: Event): void }> | undefined;
const on = (event?: Event) => {
  if (event?.type === "submit") event.preventDefault();
  (main ??= import(chat.dataset.src!)).then((module) => module.on(event), () => { main = undefined; });
};
for (const type of ["focusin", "click", "submit"]) chat.addEventListener(type, on);
chat.hidden = false;
try {
  if (localStorage.getItem(STORAGE_KEY)) on();
} catch {}
