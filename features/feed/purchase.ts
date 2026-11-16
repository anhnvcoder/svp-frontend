// State of the tier buttons of a premium video (useActionState with server/entitlement-actions.ts).

/** What the form shows after a purchase: nothing once it went through, else why it did not. */
export type PurchaseState = { error: "RATE_LIMITED" | "FAILED" | null; retryAfterSeconds: number | null };

export const initialPurchaseState: PurchaseState = { error: null, retryAfterSeconds: null };
