/** Metadata key written onto the old PI right before it's canceled by reauth. */
export const REAUTHORIZATION_METADATA_KEY = 'canceledBy';
/** Value written for the above key — the contract between core and webhook packages. */
export const REAUTHORIZATION_METADATA_VALUE = 'reauthorization-workflow';

/** Stripe cancellation reasons that are NOT genuine customer/merchant cancels. */
export const NON_CUSTOMER_CANCEL_REASONS = new Set<string>([
  'automatic',
  'expired',
  'failed_invoice',
  'void_invoice',
]);

/** Default reauth windows by card brand, in milliseconds.
 *  Visa expires at 5 days, we fire at 4. Others at 7 / fire at 6.
 */
export const REAUTH_WINDOW_MS = {
  visa: 4 * 24 * 60 * 60 * 1000,
  default: 6 * 24 * 60 * 60 * 1000,
} as const;

/** Minimum reauth timer — protects against runaway loops if the system clock
 *  drifts or someone passes a stale authCreatedAt. */
export const MIN_REAUTH_TIMER_MS = 60 * 60 * 1000; // 1 hour
