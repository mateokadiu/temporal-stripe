import { z } from 'zod';

export const StripeOrderArgsSchema = z.object({
  orderId: z.string().min(1),
  paymentIntentId: z.string().min(1),
  paymentMethodId: z.string().min(1),
  stripeAccountId: z.string().min(1),
  customerId: z.string().min(1),
  initialAmountCents: z.number().int().nonnegative(),
  currency: z.string().min(1),
  initialCardBrand: z.string().min(1),
  authCreatedAt: z.number().int().positive(),
  captureBefore: z.number().int().positive().nullable(),
  reauthorizationCount: z.number().int().nonnegative().default(0),
  metadata: z.record(z.string()).optional(),
});
// z.input — `reauthorizationCount` and `metadata` are optional in caller input;
// `initialStateFromArgs` applies defaults.
export type StripeOrderArgs = z.input<typeof StripeOrderArgsSchema>;

/** Workflow-local mutable state. Persisted via the consumer-provided
 *  `persistContext` activity after every successful state transition. */
export interface WorkflowState {
  orderId: string;
  paymentIntentId: string;
  paymentMethodId: string;
  stripeAccountId: string;
  customerId: string;
  amountCents: number;
  currency: string;
  cardBrand: string;
  authCreatedAt: number;
  captureBefore: number | null;
  reauthorizationCount: number;
  metadata: Record<string, string>;
  status: WorkflowStatus;
}

export type WorkflowStatus =
  | 'authorized'
  | 'reauthorizing'
  | 'revising'
  | 'capturing'
  | 'captured'
  | 'canceling'
  | 'canceled'
  | 'failed';

export type CancelReason = 'customer' | 'admin' | 'fraud' | 'timeout' | 'unrecoverable_error';

export function initialStateFromArgs(args: StripeOrderArgs): WorkflowState {
  return {
    orderId: args.orderId,
    paymentIntentId: args.paymentIntentId,
    paymentMethodId: args.paymentMethodId,
    stripeAccountId: args.stripeAccountId,
    customerId: args.customerId,
    amountCents: args.initialAmountCents,
    currency: args.currency,
    cardBrand: args.initialCardBrand,
    authCreatedAt: args.authCreatedAt,
    captureBefore: args.captureBefore,
    reauthorizationCount: args.reauthorizationCount ?? 0,
    metadata: args.metadata ?? {},
    status: 'authorized',
  };
}
