/** Thrown when the workflow refuses to continue (e.g. cost guard, unrecoverable
 *  Stripe error, or contract violation). Caught by the workflow loop and
 *  surfaced via the `onFailure` activity hook. */
export class StripeOrderError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'StripeOrderError';
    this.code = code;
  }
}

export const ERROR_CODES = {
  REAUTH_FAILED: 'reauth_failed',
  REVISE_INCREASE_REJECTED: 'revise_increase_rejected',
  ALREADY_CAPTURED: 'already_captured',
  ALREADY_CANCELED: 'already_canceled',
  INVARIANT_VIOLATED: 'invariant_violated',
} as const;
