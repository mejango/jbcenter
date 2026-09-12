/** Native dialogs keep account sign-in and owner approval in the same page. */
export function paraDialogHtml(): string {
  return `<dialog id="para-dialog" class="center-dialog" aria-labelledby="para-title">
  <div class="dialog-heading"><h2 id="para-title">Sign in</h2><button id="para-close" type="button" class="quiet" aria-label="Close sign-in"><span aria-hidden="true">×</span></button></div>
  <p id="para-status" role="status" aria-live="polite" hidden></p>
  <div id="para-entry">
    <form id="para-identifier-form">
      <label for="para-identifier" class="sign-in-label">Email or phone number</label>
      <input id="para-identifier" name="identifier" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="you@email.com | +1 222 333 4444" required>
      <button id="para-continue" type="submit" disabled>Continue</button>
    </form>
    <section id="para-social-group" class="sign-in-methods" aria-labelledby="para-social-label" hidden>
      <p id="para-social-label">Or, use socials</p>
      <div id="para-social" class="dialog-options"></div>
    </section>
    <section id="para-external" class="sign-in-methods" aria-labelledby="para-wallet-label" hidden>
      <p id="para-wallet-label">… or, a wallet.</p>
      <div id="para-wallets" class="dialog-options"></div>
    </section>
  </div>
  <div id="para-verify" hidden>
    <p id="para-verify-label">Enter the verification code.</p>
    <iframe id="para-verification-frame" title="Secure sign-in verification" referrerpolicy="no-referrer" hidden></iframe>
    <form id="para-code-form" hidden>
      <label for="para-code">Verification code</label>
      <input id="para-code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required>
      <button id="para-verify-code" type="submit">Verify code</button>
    </form>
    <button id="para-resend" type="button" class="quiet">Resend code</button>
  </div>
  <div id="para-credential" hidden>
    <p>Finish signing in in the secure window. If it did not open, use the button below.</p>
    <button id="para-open-credential" type="button">Open secure sign-in</button>
  </div>
  <button id="para-back" type="button" class="quiet" hidden>Use another sign-in method</button>
</dialog>
<dialog id="para-approval" class="center-dialog approval-dialog" aria-labelledby="para-approval-title">
  <div class="dialog-heading"><h2 id="para-approval-title">Review and approve</h2></div>
  <p id="para-approval-description"></p>
  <dl id="para-approval-summary" class="approval-summary"></dl>
  <details><summary>Exact signing details</summary><pre id="para-approval-details"></pre></details>
  <div class="dialog-actions"><button id="para-approval-cancel" type="button" class="quiet">Cancel</button><button id="para-approval-confirm" type="button">Approve</button></div>
</dialog>`;
}

export const paraCss = `
.center-dialog { box-sizing: border-box; width: min(32rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); margin: auto; padding: 1.5rem; color: var(--ink, #1b221c); background: var(--paper, #f5f4ee); border: 1px solid var(--line, #959c92); overflow: auto; }
.center-dialog::backdrop { background: rgb(0 0 0 / .58); }
.center-dialog [hidden] { display: none !important; }
.center-dialog h2, .center-dialog p { margin: 0; }
.center-dialog p { margin-block: 1rem; line-height: 1.55; }
.center-dialog button, .center-dialog input { box-sizing: border-box; min-height: 2.75rem; font: inherit; }
.center-dialog button { white-space: normal; }
.center-dialog form { display: grid; gap: .75rem; }
.center-dialog input { width: 100%; min-width: 0; padding: .75rem; }
.dialog-heading { display: flex; align-items: start; justify-content: space-between; gap: 1rem; }
.dialog-heading h2 { font-size: 1.3rem; line-height: 1.5; }
.dialog-heading button { flex: 0 0 auto; }
.center-dialog .quiet { color: inherit; background: transparent; border: 1px solid var(--line, #959c92); }
.dialog-options { display: flex; flex-wrap: wrap; gap: .5rem; }
.dialog-options:empty { display: none; }
#para-dialog .dialog-heading { align-items: center; margin-bottom: 1.5rem; }
#para-close { display: grid; place-items: center; width: 2.75rem; height: 2.75rem; padding: 0; border: 0; font-size: 2rem; line-height: 1; }
#para-dialog .sign-in-label { position: absolute; width: 1px; height: 1px; min-width: 0; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
#para-identifier { margin: 0; min-height: 3.25rem; }
#para-continue { justify-self: end; min-width: 7rem; }
#para-dialog .sign-in-methods { margin-top: 1.25rem; padding: 0; border: 0; }
#para-dialog .sign-in-methods p { margin: 0 0 .5rem; font-size: .875rem; color: var(--muted, #5a6257); }
#para-dialog .sign-in-icon { display: grid; place-items: center; flex: 0 0 3rem; width: 3rem; height: 3rem; min-height: 3rem; padding: .625rem; }
#para-dialog .sign-in-icon:hover:not(:disabled), #para-close:hover { background: #e9ece2; }
#para-dialog .sign-in-icon svg, #para-dialog .sign-in-icon img { display: block; width: 100%; height: 100%; object-fit: contain; }
.center-dialog details { margin-top: 1rem; padding: 1rem; }
.center-dialog details > summary { cursor: pointer; }
.center-dialog details[open] > summary { margin-bottom: 1rem; }
.center-dialog iframe { display: block; width: 100%; height: 23rem; border: 0; background: transparent; }
.center-dialog #para-back, .center-dialog #para-resend { margin-top: 1rem; }
.center-dialog [data-error="true"] { color: var(--error, #a42828); }
.approval-dialog { width: min(46rem, calc(100vw - 2rem)); }
.approval-summary { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: .65rem 1rem; margin-block: 1.25rem; }
.approval-summary dt { font-weight: bold; }
.approval-summary dd { margin: 0; overflow-wrap: anywhere; }
.center-dialog pre { padding: 1rem; max-height: 18rem; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; font-size: .8rem; }
.dialog-actions { display: flex; justify-content: end; flex-wrap: wrap; gap: .75rem; margin-top: 1.5rem; }
@media (max-width: 420px) { .center-dialog { padding: 1rem; } .approval-summary { grid-template-columns: 1fr; gap: .35rem; } .approval-summary dd { margin-bottom: .6rem; } }
`;
