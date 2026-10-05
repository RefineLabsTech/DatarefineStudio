/* datarefine.ai — the ONLY stable AI interface for the UI and for plugins.
   Providers are never called from here directly: local/BYOK go through the
   Python sidecar, Cloud AI goes through the gated Rust runtime. */

import { api, tauriInvoke, tauriInvokeStrict } from "../ipc/client";
import { authorizeAiCleaning, recordAiCleaning, type AiUsage } from "./aiQuota";
import { useLicense } from "../store/license";
import { getAiCreditVisibility } from "./aiCredits";

export type AiSource = "cloud" | "byok" | "local";
export type RouterDecision = { source: AiSource; reason: string };
export type Credits = { balance: number; reserved: number };
export type Job = { id: string; status: string; error?: string | null };
export class CloudCreditsError extends Error {
  readonly code = "cloud_credits_exhausted" as const;
  constructor() {
    super("Your Cloud AI credits are exhausted.");
    this.name = "CloudCreditsError";
  }
}
export type Entitlements = {
  cloudAi: boolean;
  aiPlugins: boolean;
  agents: boolean;
  capabilities: string[];
};

export type AiSettingsWire = {
  preferred?: string | null;
  byokConfigured: boolean;
  ollamaAvailable: boolean;
};

export async function routerSettings(): Promise<AiSettingsWire> {
  try {
    const s = (await api.settings()) as Record<string, unknown>;
    const ai = (s.ai as Record<string, unknown>) || {};
    const provider = String(ai.provider || "ollama");
    const storedKey = provider !== "ollama"
      ? Boolean(await tauriInvoke<boolean>("ai_byok_status", { provider }))
      : false;
    const localAvailable = Boolean(ai.ollama_available)
      || Boolean(await tauriInvoke<boolean>("ai_local_status"));
    return {
      preferred: (ai.source as string) || null,
      // The key is held by Rust, so determine BYOK status from the OS
      // credential manager rather than trusting a sidecar setting.
      byokConfigured: Boolean(ai.byok_configured) || storedKey || ai.source === "byok",
      ollamaAvailable: localAvailable,
    };
  } catch {
    return { preferred: null, byokConfigured: false, ollamaAvailable: false };
  }
}

const EMPTY_ENT: Entitlements = { cloudAi: false, aiPlugins: false, agents: false, capabilities: [] };

function newOperationId() {
  try {
    return crypto.randomUUID();
  } catch {
    return `ai-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  }
}

function publishCloudCredits(value: Credits | null) {
  if (typeof window === "undefined" || !value) return;
  window.dispatchEvent(new CustomEvent("datarefine-cloud-ai-credits", { detail: value }));
}

function estimatedCredits(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;
  const data = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  const raw = data.credits ?? data.estimatedCredits ?? data.cost;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export const datarefineAi = {
  /** Server-provided entitlements (never inferred from plan names). */
  async getEntitlements(): Promise<Entitlements> {
    const snap = useLicense.getState().snap;
    return snap?.entitlements ?? EMPTY_ENT;
  },

  /** Source selection: Cloud (entitled) / BYOK / Local. */
  async router(): Promise<RouterDecision> {
    const r = await tauriInvoke<RouterDecision>("ai_router", { settings: await routerSettings() });
    return r ?? { source: "local", reason: "desktop bridge unavailable" };
  },

  /**
   * Generate: Cloud uses server estimate + wallet + one idempotent job;
   * local/BYOK uses the sidecar and records one successful cleaning. No
   * desktop-side credit or monthly-usage deduction is ever fabricated.
   */
  async generate(req: {
    prompt: string;
    sessionId?: string;
    source?: AiSource;
    step?: string;
    extra?: Record<string, unknown>;
  }): Promise<{ source: AiSource; job?: Job; proposals?: unknown[]; usage?: AiUsage | null; credits?: Credits | null }> {
    const decision = req.source
      ? ({ source: req.source, reason: "explicit" } as RouterDecision)
      : await this.router();
    // Only an explicit clean step/file_cleaning job consumes the monthly
    // cleaning quota. SQL, manual tools, agents, and other plugin AI calls do
    // not become file cleanings by accident.
    const countsAsCleaning = req.step === "clean" || req.extra?.kind === "file_cleaning";
    const opId = newOperationId();
    const authorized = countsAsCleaning ? await authorizeAiCleaning(decision.source, opId) : { usage: null, operationId: opId };

    if (decision.source === "cloud") {
      // Wallet state is fetched from Rust/Cloud for every Cloud operation.
      const wallet = await this.getCredits("cloud");
      if (!wallet) throw new Error("Cloud AI credit status is unavailable.");
      const available = Math.max(0, wallet.balance - wallet.reserved);
      if (available <= 0) throw new CloudCreditsError();

      const estimate = await this.estimate({ prompt: req.prompt, source: "cloud" });
      if (estimate.credits !== null && estimate.credits > available) throw new CloudCreditsError();

      const job = await tauriInvokeStrict<Job>("ai_jobs_submit", {
        request: {
          kind: countsAsCleaning ? "file_cleaning" : "generate",
          prompt: req.prompt,
          ...(req.extra || {}),
        },
        // One stable key per logical job; retries reuse it (§25/§28).
        idempotencyKey: opId,
      });
      if (!job) throw new Error("Cloud AI unavailable or not entitled.");
      // The returned wallet is the only balance the UI may trust. A refresh
      // failure leaves it unknown; it never invents a deduction.
      let refreshed: Credits | null = null;
      try {
        refreshed = await this.getCredits("cloud");
      } catch {
        refreshed = null;
      }
      return { source: "cloud", job, usage: authorized.usage, credits: refreshed };
    }
    if (!req.sessionId) throw new Error("Local AI needs an open sheet (sessionId).");
    const settings = (await api.settings()) as Record<string, unknown>;
    const res = (await api.ai(req.sessionId, req.step || "clean", (settings.ai as Record<string, unknown>) || {}, {
      extra: req.prompt,
      ...(req.extra || {}),
    })) as { proposals?: unknown[] };
    const recorded = countsAsCleaning ? await recordAiCleaning(decision.source, authorized.operationId) : null;
    return { source: decision.source, proposals: res.proposals, usage: recorded || authorized.usage };
  },

  /** Agents are a Professional Cloud-AI capability; they use Cloud AI Credits
   * but are not counted as Community file cleanings unless explicitly submitted
   * as a file_cleaning job. */
  async runAgent(req: { instructions: string; sessionId?: string }): Promise<{ source: AiSource; job?: Job }> {
    const ent = await this.getEntitlements();
    if (!ent.agents) throw new Error("Agents require a Professional license with the agents entitlement.");
    const wallet = await this.getCredits("cloud");
    if (!wallet || wallet.balance <= wallet.reserved) throw new CloudCreditsError();
    const estimate = await this.estimate({ prompt: req.instructions, source: "cloud" });
    if (estimate.credits !== null && estimate.credits > Math.max(0, wallet.balance - wallet.reserved)) {
      throw new CloudCreditsError();
    }
    const job = await tauriInvokeStrict<Job>("ai_jobs_submit", {
      request: { kind: "agent", prompt: req.instructions },
      idempotencyKey: newOperationId(),
    });
    if (!job) throw new Error("Cloud AI unavailable or not entitled.");
    return { source: "cloud", job };
  },

  /** Cost estimate before running. Local/BYOK never enter the DataRefine wallet. */
  async estimate(req: { prompt: string; source?: AiSource }): Promise<{ source: AiSource; credits: number | null }> {
    const decision = req.source
      ? ({ source: req.source, reason: "explicit" } as RouterDecision)
      : await this.router();
    if (decision.source !== "cloud") return { source: decision.source, credits: null };
    const snap = useLicense.getState().snap;
    if (!snap?.requireLicense || snap.enforcement === "unrestricted") return { source: "cloud", credits: null };
    try {
      const result = await tauriInvokeStrict<unknown>("ai_estimate", {
        request: { kind: "file_cleaning", prompt: req.prompt },
      });
      return { source: "cloud", credits: estimatedCredits(result) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (message === "Your Cloud AI credits are exhausted.") throw new CloudCreditsError();
      // Estimate is advisory. Missing estimate support does not authorize a
      // local deduction; the server remains the final authorization point.
      return { source: "cloud", credits: null };
    }
  },

  /** Generate editor code through the central local/BYOK AI path. Cloud jobs
   * intentionally do not receive local sheet samples and therefore cannot
   * return executable code for the current sheet. */
  async generateCode(req: {
    sessionId: string;
    language: "python" | "sql" | "javascript";
    prompt: string;
    source?: AiSource;
  }): Promise<{ source: AiSource; code: string }> {
    const decision = req.source
      ? ({ source: req.source, reason: "explicit" } as RouterDecision)
      : await this.router();
    if (decision.source === "cloud") {
      throw new Error("Editor code generation requires Local or BYOK AI; Cloud AI does not receive sheet samples.");
    }
    const settings = (await api.settings()) as Record<string, unknown>;
    const result = (await api.aiCode(
      req.sessionId,
      (settings.ai as Record<string, unknown>) || {},
      req.prompt,
      req.language,
    )) as { code?: unknown; raw?: unknown };
    const code = String(result.code ?? result.raw ?? "").trim();
    if (!code) throw new Error("The AI runtime returned no editor code.");
    return { source: decision.source, code };
  },

  async getModels(): Promise<Array<{ id: string; source: AiSource }>> {
    const decision = await this.router();
    try {
      const s = (await api.settings()) as Record<string, unknown>;
      const ai = (s.ai as Record<string, unknown>) || {};
      const list = Array.isArray(ai.models) ? (ai.models as string[]) : ai.model ? [String(ai.model)] : [];
      return list.map((id) => ({ id, source: decision.source }));
    } catch {
      return [];
    }
  },

  async getCapabilities(): Promise<string[]> {
    const ent = await this.getEntitlements();
    const local = ["data_cleaning", "data_profiling"];
    return Array.from(new Set([...local, ...ent.capabilities]));
  },

  /** Credit wallet — queried only when the centralized cloud-credit rule allows it. */
  async getCredits(sourceOverride?: AiSource): Promise<Credits | null> {
    const snapshot = useLicense.getState().snap;
    const settings = await routerSettings();
    const decision = sourceOverride
      ? ({ source: sourceOverride, reason: "explicit" } as RouterDecision)
      : await tauriInvoke<RouterDecision>("ai_router", { settings });
    const eligible = getAiCreditVisibility({
      snapshot,
      source: sourceOverride || settings.preferred,
      byokConfigured: settings.byokConfigured,
      decision,
    });
    if (!eligible.visible) return null;
    const credits = await tauriInvokeStrict<Credits>("ai_credits", {
      source: decision?.source || settings.preferred,
      byokConfigured: decision?.source !== "cloud" && settings.byokConfigured,
    });
    publishCloudCredits(credits);
    return credits;
  },

  async getUsage(): Promise<{ localHistory: number; cloudJobs: number }> {
    return { localHistory: useLicense.getState() ? 0 : 0, cloudJobs: 0 };
  },

  /** Job control (cloud only). */
  jobs: {
    get: (id: string) => tauriInvoke<Job>("ai_jobs_get", { id }),
    cancel: (id: string) => tauriInvoke<Job>("ai_jobs_cancel", { id }),
  },
};

/** Exposed to plugin sandboxes as `window.datarefine.ai` (permission-checked
   in Rust via plugins::commands::plugin_ai_check before any execution). */
export function pluginAiSurface(pluginId: string) {
  const gate = (need: string, capability: string, source: AiSource) =>
    tauriInvoke<null>("plugin_ai_check", {
      root: "plugins",
      pluginId,
      need,
      capability,
      source,
    }).then((ok) => {
      if (ok === null) throw new Error("Plugin AI access denied by the runtime gate.");
      return true;
    });
  return {
    async generate(req: Parameters<typeof datarefineAi.generate>[0]) {
      const source = req.source || (await datarefineAi.router()).source;
      await gate("ai.inference", "data_cleaning", source);
      return datarefineAi.generate({ ...req, source });
    },
    async runAgent(req: Parameters<typeof datarefineAi.runAgent>[0]) {
      await gate("ai.agent", "", "cloud");
      return datarefineAi.runAgent(req);
    },
    getModels: () => datarefineAi.getModels(),
    getCapabilities: () => datarefineAi.getCapabilities(),
    getEntitlements: () => datarefineAi.getEntitlements(),
    getUsage: () => datarefineAi.getUsage(),
    getCredits: () => datarefineAi.getCredits(),
    estimate: (req: Parameters<typeof datarefineAi.estimate>[0]) => datarefineAi.estimate(req),
  };
}
