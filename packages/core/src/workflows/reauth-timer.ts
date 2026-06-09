import { MIN_REAUTH_TIMER_MS, REAUTH_WINDOW_MS } from '../constants.js';

export interface ReauthTimerInput {
  /** Card brand, lowercased. Anything other than 'visa' falls into the 'default' window. */
  cardBrand: string;
  /** epoch ms — when the PI was confirmed. */
  authCreatedAt: number;
  /** epoch ms — Stripe's hint from extended auth, if present. */
  captureBefore: number | null;
  /** Override clock for tests. Defaults to Date.now() at evaluation time. */
  now?: number;
}

/**
 * Returns milliseconds from `now` until the workflow should reauthorize.
 *
 * Priority:
 *   1. `captureBefore` (Stripe's extended-auth hint) → fire 1 day before.
 *   2. Card brand: Visa = `authCreatedAt + 4d`, others = `authCreatedAt + 6d`.
 *
 * Both branches clamp to a minimum of 1 hour from `now` so a stale
 * `authCreatedAt` (e.g. workflow resumed after a long pause) doesn't fire
 * reauth in a tight loop.
 *
 * Pure function — tested at unit level. No clock or i/o dependencies.
 */
export function getReauthTimerMs(input: ReauthTimerInput): number {
  const now = input.now ?? Date.now();
  const candidate =
    input.captureBefore !== null
      ? input.captureBefore - 24 * 60 * 60 * 1000
      : input.authCreatedAt + windowForBrand(input.cardBrand);
  return Math.max(MIN_REAUTH_TIMER_MS, candidate - now);
}

function windowForBrand(brand: string): number {
  return brand.toLowerCase() === 'visa' ? REAUTH_WINDOW_MS.visa : REAUTH_WINDOW_MS.default;
}
