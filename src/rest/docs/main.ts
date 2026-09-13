for (const button of document.querySelectorAll<HTMLButtonElement>(".copy-code")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const code = button.parentElement?.querySelector("code")?.textContent;
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      button.textContent = "Copied";
      const status = document.getElementById("copy-status");
      if (status) status.textContent = "Code copied to clipboard.";
      setTimeout(() => { button.textContent = "Copy"; }, 2000);
    } catch {
      button.textContent = "Select code to copy";
      button.parentElement?.querySelector("pre")?.focus();
    }
  });
}
const filter = document.querySelector<HTMLInputElement>("#endpoint-filter");
filter?.addEventListener("input", () => {
  const term = filter.value.trim().toLowerCase();
  let count = 0;
  for (const endpoint of document.querySelectorAll<HTMLDetailsElement>(".endpoint")) {
    endpoint.hidden = !endpoint.textContent?.toLowerCase().includes(term);
    if (!endpoint.hidden) count++;
  }
  for (const group of document.querySelectorAll<HTMLDetailsElement>(".reference > details")) {
    group.hidden = !group.querySelector(".endpoint:not([hidden])");
    if (term && !group.hidden) group.open = true;
  }
  const result = document.getElementById("endpoint-count");
  if (result) result.textContent = `${count} endpoints`;
});
