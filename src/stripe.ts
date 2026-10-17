// src/stripe.ts: the Pay implementation over stripe-node 23.0.0 (API 2026-09-30.endive). Stripe test mode only.
// One PaymentIntent per lane is the authorization hold (capture_method manual). After every mutation the
// PaymentIntent is retrieved and Stripe's own status and amount_received are returned, never an echo.
import Stripe from "stripe";
import { cfg } from "./config.js";
import type { Pay } from "./contracts.js";

export const MIN_CAPTURE_CENTS = 50;

export class SettlementPendingError extends Error {
  readonly op: string;
  readonly code?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  constructor(message: string, info: { op?: string; code?: string; statusCode?: number; requestId?: string } = {}) {
    super(message);
    this.name = "SettlementPendingError";
    this.op = info.op ?? "";
    this.code = info.code;
    this.statusCode = info.statusCode;
    this.requestId = info.requestId;
  }
}

// The slice of the Stripe client this module touches. Tests inject a fake; the real client is cast to it.
export interface PiLike {
  id: string; status: string; amount: number; amount_received?: number; metadata?: Record<string, string> | null;
}
type Opts = { idempotencyKey: string };
export interface StripeLike {
  paymentIntents: {
    create(params: Record<string, unknown>, opts: Opts): Promise<PiLike>;
    capture(id: string, params: Record<string, unknown>, opts: Opts): Promise<PiLike>;
    update(id: string, params: Record<string, unknown>, opts: Opts): Promise<PiLike>;
    cancel(id: string, params: Record<string, unknown>, opts: Opts): Promise<PiLike>;
    retrieve(id: string): Promise<PiLike>;
    list(params: { limit: number }): Promise<unknown>;
  };
}
export type HoldForm = "allowed_payment_method_types" | "automatic_payment_methods";

// ── Key guard ───────────────────────────────────────────────────────────
// The app talks to the Dashboard test secret key of the envoy sandbox, never the CLI session key and never a live key.
export function keyClass(key: string): "sk_test" | "rk_test" | null {
  if (key.startsWith("sk_test_")) return "sk_test";
  if (key.startsWith("rk_test_")) return "rk_test";
  return null;
}
export function assertTestKey(key: string): void {
  if (keyClass(key) === null) {
    throw new Error("Stripe key refused: STRIPE_SECRET_KEY must be a test-mode secret key (sk_test_ or rk_test_)");
  }
}

let shared: { key: string; client: StripeLike } | null = null;
function realClient(key: string): StripeLike {
  assertTestKey(key);
  if (shared && shared.key === key) return shared.client;
  // stripe@23.0.0 pins API version 2026-09-30.endive. Two retries reuse the same idempotency key.
  const client = new Stripe(key, { maxNetworkRetries: 2, timeout: 20_000 }) as unknown as StripeLike;
  shared = { key, client };
  return client;
}

// ── Errors ──────────────────────────────────────────────────────────────
function scrub(text: string): string {
  let t = text.replace(/\b(?:sk|rk|pk)_(?:test|live)_[A-Za-z0-9_*]+/g, "[key]").replace(/\bwhsec_[A-Za-z0-9_*]+/g, "[secret]");
  if (cfg.stripeKey) t = t.split(cfg.stripeKey).join("[key]");
  return t.replace(/\s+/g, " ").trim();
}

function pending(op: string, e: unknown): SettlementPendingError {
  const r = (e ?? {}) as { code?: unknown; type?: unknown; statusCode?: unknown; requestId?: unknown; message?: unknown };
  const code = typeof r.code === "string" ? r.code : typeof r.type === "string" ? r.type : undefined;
  const text = scrub(typeof r.message === "string" ? r.message : String(e)).slice(0, 200);
  return new SettlementPendingError(`settlement pending: ${op} failed${code ? ` (${code})` : ""}: ${text}`, {
    op, code,
    statusCode: typeof r.statusCode === "number" ? r.statusCode : undefined,
    requestId: typeof r.requestId === "string" ? r.requestId : undefined,
  });
}

// stripe-node has already retried twice with the same idempotency key; a final failure leaves the hold alone.
async function call<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw pending(op, e);
  }
}

// ── Metadata (at most 50 keys, 40-character names, 500-character values; all values strings) ──
export function checkMetadata(md: Record<string, string>): void {
  const keys = Object.keys(md);
  if (keys.length > 50) throw new RangeError(`metadata: ${keys.length} keys, the limit is 50`);
  for (const k of keys) {
    if (k.length === 0) throw new RangeError("metadata: empty key");
    if (k.length > 40) throw new RangeError(`metadata: key "${k.slice(0, 20)}..." is ${k.length} characters, the limit is 40`);
    const v = md[k];
    if (typeof v !== "string") throw new TypeError(`metadata: value of "${k}" is not a string`);
    if (v.length > 500) throw new RangeError(`metadata: value of "${k}" is ${v.length} characters, the limit is 500`);
  }
}

// ── Pay ─────────────────────────────────────────────────────────────────
function shape(pi: PiLike) {
  return { status: pi.status, amount: pi.amount, amountReceived: pi.amount_received ?? 0, metadata: { ...(pi.metadata ?? {}) } };
}

const mentionsReturnUrl = (e: unknown): boolean => /return_url/i.test(String((e as { message?: unknown } | null)?.message ?? ""));

// holdForm() tells which create form the last hold used (for the smoke status line).
export function createPay(o: { stripe?: StripeLike; key?: string } = {}): Pay & { holdForm(): HoldForm | null } {
  const s = o.stripe ?? realClient(o.key ?? cfg.stripeKey);
  let form: HoldForm | null = null;

  const get = async (piId: string) => shape(await call("retrieve", () => s.paymentIntents.retrieve(piId)));

  return {
    holdForm: () => form,

    async hold(key, cents, description, md) {
      if (!Number.isInteger(cents) || cents <= 0) throw new RangeError("hold: cents must be a positive integer");
      checkMetadata(md);
      const base = { amount: cents, currency: "usd", capture_method: "manual", confirm: true, payment_method: "pm_card_visa", description, metadata: md };
      let pi: PiLike;
      try {
        pi = await s.paymentIntents.create({ ...base, allowed_payment_method_types: ["card"] }, { idempotencyKey: `${key}:hold` });
        form = "allowed_payment_method_types";
      } catch (e) {
        if (!mentionsReturnUrl(e)) throw pending("hold", e);
        // Only when confirm asks for a return_url: the other form, under its own key, never both parameters.
        try {
          pi = await s.paymentIntents.create(
            { ...base, automatic_payment_methods: { enabled: true, allow_redirects: "never" } },
            { idempotencyKey: `${key}:hold-apm` },
          );
          form = "automatic_payment_methods";
        } catch (e2) {
          throw pending("hold", e2);
        }
      }
      return { id: pi.id, status: (await get(pi.id)).status };
    },

    async capture(key, piId, cents, md) {
      // Stripe would fail an amount under the account's floor; the product never asks for less than 50 cents.
      if (!Number.isInteger(cents) || cents < MIN_CAPTURE_CENTS) {
        throw new RangeError(`capture: ${cents} cents is under the ${MIN_CAPTURE_CENTS} cent minimum; release the hold instead`);
      }
      checkMetadata(md);
      await call("capture", () => s.paymentIntents.capture(piId, { amount_to_capture: cents, metadata: md }, { idempotencyKey: `${key}:cap` }));
      const got = await get(piId);
      return { status: got.status, amountReceived: got.amountReceived };
    },

    async release(key, piId, md) {
      checkMetadata(md);
      // Metadata first, then cancel: DESIGN 9.7 keeps this order even though Stripe accepts metadata after a cancel.
      await call("release (metadata)", () => s.paymentIntents.update(piId, { metadata: md }, { idempotencyKey: `${key}:md` }));
      const mid = await get(piId);
      if (mid.status === "canceled") return { status: mid.status };   // a replay after a partial release
      await call("release (cancel)", () => s.paymentIntents.cancel(piId, { cancellation_reason: "abandoned" }, { idempotencyKey: `${key}:cxl` }));
      return { status: (await get(piId)).status };
    },

    retrieve: (piId) => get(piId),
  };
}

// For /api/selfcheck: one list call. Returns "ok" or a short error with no key in it. Never throws.
export async function pingStripe(o: { stripe?: StripeLike } = {}): Promise<string> {
  try {
    const s = o.stripe ?? realClient(cfg.stripeKey);
    await s.paymentIntents.list({ limit: 1 });
    return "ok";
  } catch (e) {
    return scrub(e instanceof Error ? e.message : String(e)).slice(0, 120) || "error";
  }
}
