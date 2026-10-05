import { useMemo } from "react";
import { useLicense } from "../store/license";
import type { LicenseSnapshot } from "../license/types";
import type { RouterDecision } from "./ai";

/** Inputs used by every AI-credit surface. */
export type AiCreditVisibilityInput = {
  snapshot: LicenseSnapshot | null;
  /** The user's selected source: auto, cloud, byok, or local. */
  source?: string | null;
  /** True when a provider key exists in the OS credential manager. */
  byokConfigured: boolean;
  /** The source the central router will actually use. */
  decision?: RouterDecision | null;
};

export type AiCreditVisibility = {
  visible: boolean;
  requireLicense: boolean;
  byok: boolean;
  cloud: boolean;
  purchaseEnabled: boolean;
  purchaseUrl: string | null;
};

function creditPurchaseConfig(snapshot: LicenseSnapshot | null) {
  const config = snapshot?.config;
  const licensing = config?.licensing;
  const enabled = Boolean(config?.enableAiCreditPurchase ?? licensing?.enableAiCreditPurchase);
  const url = String(config?.aiCreditPurchaseUrl ?? licensing?.aiCreditPurchaseUrl ?? "").trim();
  return { enabled, url: url || null };
}

/**
 * Single source of truth for whether DataRefine's cloud-credit wallet may be
 * shown or queried. BYOK/local AI never enters the wallet path.
 */
export function getAiCreditVisibility(input: AiCreditVisibilityInput): AiCreditVisibility {
  const snapshot = input.snapshot;
  const requireLicense = Boolean(snapshot?.requireLicense) && snapshot?.enforcement !== "unrestricted";
  // A stored BYOK key alone must not hide the wallet when the user has
  // explicitly switched the active source to Cloud. Visibility follows the
  // effective provider, not every credential stored on the machine. An
  // explicit selection wins immediately while the Rust router catches up.
  const explicit = input.source === "cloud" || input.source === "byok" || input.source === "local" ? input.source : null;
  const effective = explicit || input.decision?.source || null;
  const byok = effective === "byok" || effective === "local";
  const cloud = effective === "cloud";
  const visible = Boolean(requireLicense && !byok && cloud && snapshot?.entitlements?.cloudAi);
  const purchase = creditPurchaseConfig(snapshot);

  return {
    visible,
    requireLicense,
    byok,
    cloud,
    purchaseEnabled: visible && purchase.enabled && Boolean(purchase.url),
    purchaseUrl: purchase.url,
  };
}

/** React hook used by UI components that render AI-credit information. */
export function useAiCreditVisibility(input: Omit<AiCreditVisibilityInput, "snapshot">) {
  const snapshot = useLicense((s) => s.snap);
  return useMemo(
    () => getAiCreditVisibility({ ...input, snapshot }),
    [snapshot, input.source, input.byokConfigured, input.decision?.source, input.decision?.reason],
  );
}
