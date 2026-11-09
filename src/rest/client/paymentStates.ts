/** Every state a reviewed payment can be in.
 * `expired`: published but never included before its signed validity ended; it cannot execute. */
export const paymentStates = ['reviewing', 'approved', 'submitting', 'pending', 'confirming', 'paid', 'reverted', 'cancelled', 'unknown', 'expired'] as const;
export type CenterWalletPaymentState = typeof paymentStates[number];
/** The payment states that end a payment: nothing more happens to it, so it can be cleared and
 * never holds up a new sign-in or payment. */
const settledPaymentStates: readonly CenterWalletPaymentState[] = ['paid', 'reverted', 'cancelled', 'expired'];
export const isSettledPayment = (status: string) => (settledPaymentStates as readonly string[]).includes(status);
