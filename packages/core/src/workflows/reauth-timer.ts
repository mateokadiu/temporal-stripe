import {
  DEFAULT_BRAND_EXPIRY_OVERRIDES_MS,
  MIN_REAUTH_TIMER_MS,
  REAUTH_WINDOW_MS,
} from '../constants.js';

export interface ReauthTimerInput {
  /** Card brand, lowercased. Anything other than 'visa' falls into the 'default' window. */
  cardBrand: string;
  /** epoch ms — when the PI was confirmed. */
  authCreatedAt: number;
  /** epoch ms — Stripe's hint from extended auth, if present. */
  captureBefore: number | null;
  /** Override clock for tests. Defaults to Date.now() at evaluation time. */
  now?: number;
  /**
   * Per-brand expiry overrides. Keys are lowercased brand strings, values are
   * milliseconds from `authCreatedAt`. Merged on top of the package defaults;
   * an explicit override always wins. Unknown brands fall back to the
   * `REAUTH_WINDOW_MS.default` window.
   */
  brandExpiryOverrides?: Readonly<Record<string, number>>;
}

/**
 * Returns milliseconds from `now` until the workflow should reauthorize.
 *
 * Priority:
 *   1. `captureBefore` (Stripe's extended-auth hint) → fire 1 day before.
 *   2. Per-brand override from `brandExpiryOverrides` (caller-supplied).
 *   3. Package-default override map (Visa = 4d).
 *   4. `REAUTH_WINDOW_MS.default` (6d).
 *
 * All branches clamp to a minimum of 1 hour from `now` so a stale
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
      : input.authCreatedAt + windowForBrand(input.cardBrand, input.brandExpiryOverrides);
  return Math.max(MIN_REAUTH_TIMER_MS, candidate - now);
}

function windowForBrand(
  brand: string,
  overrides: Readonly<Record<string, number>> | undefined,
): number {
  const key = brand.toLowerCase();
  if (overrides && key in overrides) {
    return overrides[key]!;
  }
  if (key in DEFAULT_BRAND_EXPIRY_OVERRIDES_MS) {
    return DEFAULT_BRAND_EXPIRY_OVERRIDES_MS[key]!;
  }
  return REAUTH_WINDOW_MS.default;
}
