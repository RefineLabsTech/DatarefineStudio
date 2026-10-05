import { tauriInvokeStrict } from "../ipc/client";
import { useLicense } from "../store/license";
import type { AiSource } from "./ai";

export const COMMUNITY_AI_LIMIT = 15;
export const COMMUNITY_LIMIT_MESSAGE =
  "Your Community plan includes 15 AI file cleanings per month. Your monthly limit has been reached.";

export type AiUsage = {
  plan: string;
  /** Server-selected calendar month, never derived by the desktop. */
  month: string;
  used: number;
  limit: number | null;
  unlimited: boolean;
  allowed: boolean;
  message?: string | null;
  upgradeUrl?: string | null;
};

export class AiQuotaError extends Error {
  readonly upgradeUrl: string | null;
  readonly code: "monthly_limit" | "service";

  constructor(message: string, upgradeUrl: string | null = null, code: "monthly_limit" | "service" = "service") {
    super(message);
    this.name = "AiQuotaError";
    this.upgradeUrl = upgradeUrl;
    this.code = code;
  }
}

function enforced() {
  const snap = useLicense.getState().snap;
  return Boolean(snap?.requireLicense && snap.enforcement !== "unrestricted");
}

function configuredUpgradeUrl(): string | null {
  const config = useLicense.getState().snap?.config;
  const value = config?.links?.buyUrl || config?.buyUrl || config?.aiCreditPurchaseUrl || config?.licensing?.aiCreditPurchaseUrl || "";
  return String(value).trim() || null;
}

function operationId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }
}

function asErrorMessage(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) return String((error as { message?: unknown }).message || "");
  return String(error || "AI usage service unavailable.");
}

/**
 * Authorize one AI file-cleaning operation against the server's current
 * calendar-month usage. In unrestricted mode this returns without invoking
 * Rust or the cloud.
 */
export async function authorizeAiCleaning(source: AiSource, id = operationId()): Promise<{ usage: AiUsage | null; operationId: string }> {
  if (!enforced()) return { usage: null, operationId: id };
  let usage: AiUsage;
  try {
    usage = await tauriInvokeStrict<AiUsage>("ai_usage_check", { source, operationId: id });
  } catch (error) {
    throw new AiQuotaError(asErrorMessage(error), null, "service");
  }
  const upgradeUrl = usage.upgradeUrl || configuredUpgradeUrl();
  if (!usage.allowed) {
    const atCommunityLimit = usage.limit !== null && usage.used >= usage.limit;
    throw new AiQuotaError(
      atCommunityLimit ? COMMUNITY_LIMIT_MESSAGE : usage.message || "Your monthly AI file-cleaning limit has been reached.",
      upgradeUrl,
      atCommunityLimit ? "monthly_limit" : "service",
    );
  }
  return { usage, operationId: id };
}

/**
 * Record successful local/BYOK completion on the server. Cloud jobs are
 * consumed/settled by the Cloud job service and must not be locally deducted.
 */
export async function recordAiCleaning(source: AiSource, id: string): Promise<AiUsage | null> {
  if (!enforced()) return null;
  try {
    return await tauriInvokeStrict<AiUsage>("ai_usage_record", { source, operationId: id });
  } catch (error) {
    throw new AiQuotaError(asErrorMessage(error), null, "service");
  }
}

/** Startup/settings refresh. It is deliberately read-only: `/check` never
 * increments usage and the server chooses the current calendar month. */
export async function refreshAiUsage(source: AiSource): Promise<AiUsage | null> {
  if (!enforced()) return null;
  try {
    return await tauriInvokeStrict<AiUsage>("ai_usage_check", {
      source,
      operationId: operationId(),
    });
  } catch {
    return null;
  }
}

export function isCommunityUsage(usage: AiUsage | null | undefined) {
  return Boolean(usage && usage.limit !== null && !usage.unlimited);
}
