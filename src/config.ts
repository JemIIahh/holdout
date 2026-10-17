// src/config.ts: loads .env, then .env.local (the later file wins); real environment variables win over both.
// Deploy has neither file, so a missing file is fine. Never reads ANTHROPIC_*.
import { existsSync, readFileSync } from "node:fs";

function parse(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i < 1) continue;
    const k = line.slice(0, i).trim();
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    if (!k.startsWith("ANTHROPIC_")) out[k] = v;
  }
  return out;
}

const env: Record<string, string | undefined> = { ...parse(".env"), ...parse(".env.local") };
for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ANTHROPIC_")) env[k] = v;

const SEAL_RULES = ["192.0.2.1/32", "240.0.0.0/4"];
const sealRule = env.SEAL_RULE ?? "192.0.2.1/32";
if (!SEAL_RULES.includes(sealRule)) {
  throw new Error(`config: SEAL_RULE must be one of ${SEAL_RULES.join(" or ")}; refusing to boot`);
}

const vmMode = (env.VM_MODE ?? "fresh") === "reuse" ? "reuse" : "fresh";
const onTrip = (env.ON_TRIP ?? "metered") === "nothing" ? "nothing" : "metered";
const runaway = (env.RUNAWAY ?? "fast") === "busyloop" ? "busyloop" : "fast";

export const cfg = {
  routerKey: env.ROUTER_API_KEY ?? "",
  routerBase: env.ROUTER_BASE_URL || "https://router-api.0g.ai",
  model: env.MODEL || "claude-opus-5.5",
  fallbackModel: env.FALLBACK_MODEL || "claude-opus-5",
  stripeKey: env.STRIPE_SECRET_KEY ?? "",
  createosKey: env.CREATEOS_SANDBOX_API_KEY ?? "",
  createosBase: env.CREATEOS_SANDBOX_BASE_URL || "https://api.sb.createos.sh",
  adminToken: env.ADMIN_TOKEN ?? "",
  hiddenSeed: env.HIDDEN_SEED ?? "",
  sealRule,
  vmMode: vmMode as "fresh" | "reuse",
  devVmId: env.DEV_VM_ID ?? "",
  concurrency: Number(env.CONCURRENCY) || 1,
  notary: env.NOTARY === "1",
  runaway: runaway as "fast" | "busyloop",
  onTrip: onTrip as "metered" | "nothing",
  rateCard: env.RATE_CARD || "rc1",
  createCap: Number(env.CREATE_CAP) || 10,
  forceCreate: env.FORCE_CREATE === "1",
  port: Number(env.PORT) || 8080,
};
export type Config = typeof cfg;
