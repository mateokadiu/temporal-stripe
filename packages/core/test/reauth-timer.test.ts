import { describe, expect, it } from 'vitest';
import { getReauthTimerMs } from '../src/workflows/reauth-timer.js';
import { MIN_REAUTH_TIMER_MS, REAUTH_WINDOW_MS } from '../src/constants.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('getReauthTimerMs', () => {
  it('Visa with no captureBefore fires at +4d from authCreatedAt', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({ cardBrand: 'visa', authCreatedAt: now, captureBefore: null, now }),
    ).toBe(REAUTH_WINDOW_MS.visa);
  });

  it('Mastercard fires at +6d from authCreatedAt', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({ cardBrand: 'mastercard', authCreatedAt: now, captureBefore: null, now }),
    ).toBe(REAUTH_WINDOW_MS.default);
  });

  it('unknown brand falls into default window', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({ cardBrand: 'something-new', authCreatedAt: now, captureBefore: null, now }),
    ).toBe(REAUTH_WINDOW_MS.default);
  });

  it('captureBefore beats card-brand default — fires 1d before captureBefore', () => {
    const now = 1_000_000_000_000;
    const captureBefore = now + 10 * DAY; // Stripe granted 10d extended auth
    expect(
      getReauthTimerMs({ cardBrand: 'visa', authCreatedAt: now, captureBefore, now }),
    ).toBe(10 * DAY - DAY);
  });

  it('case-insensitive on brand', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({ cardBrand: 'VISA', authCreatedAt: now, captureBefore: null, now }),
    ).toBe(REAUTH_WINDOW_MS.visa);
  });

  it('clamps to MIN_REAUTH_TIMER_MS when stale authCreatedAt would fire in the past', () => {
    const now = 1_000_000_000_000;
    const ancient = now - 10 * DAY;
    expect(
      getReauthTimerMs({ cardBrand: 'visa', authCreatedAt: ancient, captureBefore: null, now }),
    ).toBe(MIN_REAUTH_TIMER_MS);
  });

  it('clamps when captureBefore is in the past', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({ cardBrand: 'visa', authCreatedAt: now, captureBefore: now - DAY, now }),
    ).toBe(MIN_REAUTH_TIMER_MS);
  });

  it('returns positive value just above MIN when capture window is exactly the floor', () => {
    const now = 1_000_000_000_000;
    const result = getReauthTimerMs({
      cardBrand: 'visa',
      authCreatedAt: now - REAUTH_WINDOW_MS.visa + MIN_REAUTH_TIMER_MS,
      captureBefore: null,
      now,
    });
    expect(result).toBe(MIN_REAUTH_TIMER_MS);
  });

  it('per-brand override takes precedence over the library default', () => {
    const now = 1_000_000_000_000;
    const customAmex = 3 * DAY; // override Amex to fire at 3d
    expect(
      getReauthTimerMs({
        cardBrand: 'amex',
        authCreatedAt: now,
        captureBefore: null,
        now,
        brandExpiryOverrides: { amex: customAmex },
      }),
    ).toBe(customAmex);
  });

  it('per-brand override is case-insensitive on the brand', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({
        cardBrand: 'JCB',
        authCreatedAt: now,
        captureBefore: null,
        now,
        brandExpiryOverrides: { jcb: 2 * DAY },
      }),
    ).toBe(2 * DAY);
  });

  it('caller override beats the package-default override (Visa)', () => {
    const now = 1_000_000_000_000;
    // Override Visa from 4d down to 2d.
    expect(
      getReauthTimerMs({
        cardBrand: 'visa',
        authCreatedAt: now,
        captureBefore: null,
        now,
        brandExpiryOverrides: { visa: 2 * DAY },
      }),
    ).toBe(2 * DAY);
  });

  it('captureBefore still beats per-brand overrides', () => {
    const now = 1_000_000_000_000;
    const captureBefore = now + 10 * DAY;
    expect(
      getReauthTimerMs({
        cardBrand: 'amex',
        authCreatedAt: now,
        captureBefore,
        now,
        brandExpiryOverrides: { amex: 3 * DAY },
      }),
    ).toBe(10 * DAY - DAY);
  });

  it('unknown brand with no override falls into the default window', () => {
    const now = 1_000_000_000_000;
    expect(
      getReauthTimerMs({
        cardBrand: 'unionpay',
        authCreatedAt: now,
        captureBefore: null,
        now,
        brandExpiryOverrides: { jcb: 2 * DAY },
      }),
    ).toBe(REAUTH_WINDOW_MS.default);
  });
});
