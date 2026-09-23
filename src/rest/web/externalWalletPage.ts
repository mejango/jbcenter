/** The wallet handles approvals; this native dialog only selects the connection. */
export function externalWalletDialogHtml(): string {
  return `<dialog id="external-wallet-dialog" class="center-dialog" aria-labelledby="external-wallet-title">
  <div class="dialog-heading"><h2 id="external-wallet-title">Connect a wallet</h2><button id="external-wallet-close" type="button" class="quiet" aria-label="Close sign-in"><span aria-hidden="true">×</span></button></div>
  <p id="external-wallet-status" role="status" aria-live="polite" hidden></p>
  <div id="external-wallet-wallets" class="dialog-options"></div>
</dialog>`;
}

export const externalWalletCss = `
.center-dialog { box-sizing: border-box; width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); margin: auto; padding: 1.5rem; color: var(--ink, #1b221c); background: var(--paper, #f5f4ee); border: 1px solid var(--line, #959c92); overflow: auto; }
.center-dialog::backdrop { background: rgb(0 0 0 / .58); }
.center-dialog [hidden] { display: none !important; }
.center-dialog h2, .center-dialog p { margin: 0; }
.center-dialog p { margin-block: 1rem; line-height: 1.55; }
.center-dialog button { box-sizing: border-box; min-height: 2.75rem; font: inherit; white-space: normal; }
.dialog-heading { display: flex; align-items: center; justify-content: space-between; gap: 1rem; margin-bottom: 1.5rem; }
.dialog-heading h2 { font-size: 1.3rem; line-height: 1.5; }
.dialog-heading button { flex: 0 0 auto; }
.center-dialog .quiet { color: inherit; background: transparent; border: 1px solid var(--line, #959c92); }
.dialog-options { display: flex; flex-wrap: wrap; gap: .5rem; }
.dialog-options:empty { display: none; }
#external-wallet-close { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0; border: 0; font-size: 2rem; line-height: 1; }
.center-dialog .sign-in-icon { display: grid; place-items: center; flex: 0 0 3rem; width: 3rem; height: 3rem; min-height: 3rem; padding: .625rem; }
.center-dialog .sign-in-icon:hover:not(:disabled), #external-wallet-close:hover { background: #e9ece2; }
.center-dialog .sign-in-icon svg, .center-dialog .sign-in-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
.center-dialog [data-error="true"] { color: var(--error, #a42828); }
@media (max-width: 420px) { .center-dialog { padding: 1rem; } }
`;
