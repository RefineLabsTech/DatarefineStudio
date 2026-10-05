import { create } from "zustand";
import { api, type AiDiff, type AiOp, type AiPreviewResult, type ProfileCol } from "../ipc/client";
import { authorizeAiCleaning, AiQuotaError, recordAiCleaning, refreshAiUsage, type AiUsage } from "../services/aiQuota";
import { datarefineAi, type Job } from "../services/ai";
import { useLicense } from "./license";
import { useUI } from "./ui";
import { useWorkspace } from "./workspace";

export type AiScope = "sheet" | "columns" | "rows";
export type AiPhase = "idle" | "detect" | "plan" | "preview" | "apply";

export type HistoryItem = {
  id: string;
  ts: string;
  title: string;
  cells: number;
};

export type AiScan = {
  sid: string;
  rows: number;
  columns: number;
  missing: number;
  duplicates: number;
  profileCount: number;
  sampleRows: number;
  profiles: ProfileCol[];
  scannedAt: string;
};

export const DEFAULT_ACCEPT = 0.95;

export function clampAccept(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_ACCEPT;
  let v = n;
  if (v > 1) v = v / 100;
  return Math.min(1, Math.max(0.5, v));
}

export function acceptPct(n: number): number {
  return Math.round(clampAccept(n) * 100);
}

export function bucketFor(conf: number, acceptMin: number): "auto" | "review" | "ignore" {
  const a = clampAccept(acceptMin);
  let c = Number.isFinite(conf) ? conf : 0;
  if (c > 1) c = c / 100;
  if (c >= a) return "auto";
  if (c >= a - 0.15) return "review";
  return "ignore";
}

function classify(plan: AiOp[], diffs: AiDiff[], acceptMin: number, preserveEnabled: boolean) {
  const plan2 = plan.map((o) => {
    const bucket = bucketFor(Number(o.confidence) || 0, acceptMin);
    let enabled: boolean;
    if (bucket === "ignore") enabled = false;
    else if (preserveEnabled && o.bucket === "ignore") enabled = true;
    else if (preserveEnabled) enabled = o.enabled !== false;
    else enabled = true;
    return { ...o, bucket, enabled };
  });
  const diffs2 = diffs.map((d) => ({
    ...d,
    bucket: bucketFor(Number(d.confidence) || 0, acceptMin),
  }));
  const buckets: Record<string, number> = { auto: 0, review: 0, ignore: 0 };
  for (const o of plan2) {
    buckets[o.bucket] = (buckets[o.bucket] || 0) + (o.cells || 0);
  }
  return { plan: plan2, diffs: diffs2, buckets };
}

type State = {
  phase: AiPhase;
  busy: boolean;
  progress: string;
  error: string;
  locked: boolean;
  /** Latest server-authoritative monthly usage returned for this workspace. */
  quota: AiUsage | null;
  quotaUpgradeUrl: string | null;
  extra: string;
  useLlm: boolean;
  scope: AiScope;
  acceptMin: number;
  plan: AiOp[];
  diffs: AiDiff[];
  profiles: ProfileCol[];
  buckets: Record<string, number>;
  history: HistoryItem[];
  scan: AiScan | null;
  setScan: (scan: AiScan | null) => void;
  llm: boolean;
  boundSid: string | null;
  cloudJob: Job | null;
  setCloudJob: (job: Job | null) => void;
  generate: () => Promise<void>;
  refreshQuota: () => Promise<void>;
  apply: (mode: "auto" | "accepted" | "policy", onlyOperationIds?: string[]) => Promise<void>;
  setOpEnabled: (id: string, enabled: boolean) => void;
  setDiffStatus: (key: string, status: AiDiff["status"]) => void;
  acceptCell: (row: number, column: string) => void;
  rejectCell: (row: number, column: string) => void;
  setScope: (scope: AiScope) => void;
  setExtra: (extra: string) => void;
  setUseLlm: (v: boolean) => void;
  setLocked: (v: boolean) => void;
  setAcceptMin: (v: number) => void;
  loadLock: () => Promise<void>;
  clearPreview: () => void;
};

function diffKey(d: { row: number; column: string }) {
  return `${d.row}:${d.column}`;
}

function dropReview(highlights: Record<string, string>) {
  const next = { ...highlights };
  for (const k of Object.keys(next)) {
    if (next[k] === "review" || next[k] === "preview") delete next[k];
  }
  return next;
}

let persistTimer: ReturnType<typeof setTimeout> | undefined;
function persistAccept(acceptMin: number) {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(async () => {
    try {
      const s = await api.settings();
      const ai = { ...((s.ai as Record<string, unknown>) || {}), accept_confidence: acceptMin };
      await api.saveSettings({ ...s, ai });
    } catch {
      /* sidecar down */
    }
  }, 400);
}

export const useAiPipeline = create<State>((set, get) => ({
  phase: "idle",
  busy: false,
  progress: "",
  error: "",
  locked: false,
  quota: null,
  quotaUpgradeUrl: null,
  extra: "",
  useLlm: false,
  scope: "sheet",
  acceptMin: DEFAULT_ACCEPT,
  plan: [],
  diffs: [],
  profiles: [],
  buckets: {},
  history: [],
  scan: null,
  setScan: (scan) => set({ scan }),
  llm: false,
  boundSid: null,
  cloudJob: null,
  setCloudJob: (cloudJob) => set({ cloudJob }),
  setScope: (scope) => set({ scope }),
  setExtra: (extra) => set({ extra }),
  setUseLlm: (useLlm) => set({ useLlm }),
  setLocked: (locked) => set({ locked }),
  setAcceptMin: (v) => {
    const acceptMin = clampAccept(v);
    const classified = classify(get().plan, get().diffs, acceptMin, true);
    set({ acceptMin, ...classified });
    persistAccept(acceptMin);
  },
  loadLock: async () => {
    try {
      const s = await api.settings();
      const ai = (s.ai as Record<string, unknown>) || {};
      const ws = (ai.workspace as { extra?: string }) || {};
      const acceptMin = clampAccept(Number(ai.accept_confidence ?? get().acceptMin));
      const classified = classify(get().plan, get().diffs, acceptMin, true);
      set({ locked: Boolean(ai.config_locked), extra: ws.extra || get().extra, acceptMin, ...classified });
    } catch {
      /* sidecar down */
    }
  },
  clearPreview: () => {
    const ws = useWorkspace.getState();
    ws.mergeHighlights([]);
    useWorkspace.setState({ highlights: dropReview(ws.highlights) });
    set({ plan: [], diffs: [], buckets: {}, phase: "idle", error: "", progress: "", boundSid: null, cloudJob: null });
  },
  setOpEnabled: (id, enabled) => {
    set({ plan: get().plan.map((o) => (o.id === id ? { ...o, enabled } : o)) });
  },
  setDiffStatus: (key, status) => {
    set({
      diffs: get().diffs.map((d) => (diffKey(d) === key ? { ...d, status } : d)),
    });
  },
  acceptCell: (row, column) => {
    set({
      diffs: get().diffs.map((d) => (d.row === row && d.column === column ? { ...d, status: "accepted" } : d)),
    });
  },
  rejectCell: (row, column) => {
    const key = `${row}:${column}`;
    const hl = { ...useWorkspace.getState().highlights };
    delete hl[key];
    useWorkspace.setState({ highlights: hl });
    set({
      diffs: get().diffs.map((d) => (d.row === row && d.column === column ? { ...d, status: "rejected" } : d)),
    });
  },
  refreshQuota: async () => {
    const snap = useLicense.getState().snap;
    if (!snap?.requireLicense || snap.enforcement === "unrestricted") {
      set({ quota: null });
      return;
    }
    const decision = await datarefineAi.router();
    const usage = await refreshAiUsage(decision.source);
    if (usage) set({ quota: usage });
  },
  generate: async () => {
    const ws = useWorkspace.getState();
    const sid = ws.sessionId;
    if (!sid) {
      set({ error: "Open a dataset first." });
      return;
    }
    set({ busy: true, error: "", quotaUpgradeUrl: null, phase: "detect", progress: "Checking AI access…", cloudJob: null });
    try {
      const ui = useUI.getState();
      ui.setBottomTab("aiplan");
      ui.setBottomOpen(true);
      const scope = get().scope;
      const columns = scope === "columns" ? ws.selectedColumns : [];
      const rows = scope === "rows" ? ws.selectedRows : [];
      const decision = await datarefineAi.router();

      // Cloud cleaning is a server job. Do not send sheet contents, columns,
      // rows, or session identifiers to Cloud; the local sheet remains the
      // source of truth and no Cloud job silently mutates it.
      if (decision.source === "cloud") {
        set({ phase: "plan", progress: "Checking Cloud AI credits…" });
        const result = await datarefineAi.generate({
          source: "cloud",
          step: "clean",
          prompt: get().extra || "Generate a data-cleaning proposal for the current user-approved workflow.",
        });
        set({
          phase: "idle",
          progress: result.job ? `Cloud AI job ${result.job.id} submitted — waiting for results.` : "Cloud AI request submitted.",
          plan: [],
          diffs: [],
          buckets: {},
          profiles: [],
          boundSid: null,
          quota: result.usage || null,
          cloudJob: result.job || null,
        });
        return;
      }

      const authorization = await authorizeAiCleaning(decision.source);
      set({ phase: "plan", progress: "Building execution plan…", quota: authorization.usage });
      const settings = await api.settings();
      const ai = (settings.ai as Record<string, unknown>) || {};
      const acceptMin = clampAccept(Number(ai.accept_confidence ?? get().acceptMin));
      const r = (await api.aiPreview(sid, {
        columns,
        rows,
        extra: get().extra,
        use_llm: get().useLlm,
        settings: ai,
        threshold: acceptMin,
      })) as AiPreviewResult;
      if (r.wrote) throw new Error("Preview must not write the sheet.");
      const recorded = await recordAiCleaning(decision.source, authorization.operationId);
      const classified = classify(
        r.plan || [],
        (r.diffs || []).map((d) => ({ ...d, status: "pending" as const })),
        acceptMin,
        false,
      );
      set({
        phase: "preview",
        progress: "Preview ready — nothing written.",
        ...classified,
        profiles: (r.profiles || []) as ProfileCol[],
        llm: Boolean(r.llm),
        boundSid: sid,
        acceptMin,
        quota: recorded || authorization.usage,
        quotaUpgradeUrl: null,
        cloudJob: null,
      });
      const keep = dropReview(useWorkspace.getState().highlights);
      useWorkspace.setState({ highlights: keep });
      if (r.highlights?.length) useWorkspace.getState().mergeHighlights(r.highlights);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const quotaError = e instanceof AiQuotaError;
      set({
        error: message,
        phase: "idle",
        progress: "",
        quotaUpgradeUrl: quotaError ? e.upgradeUrl : null,
      });
    } finally {
      set({ busy: false });
    }
  },
  apply: async (mode, onlyOperationIds) => {
    const ws = useWorkspace.getState();
    const sid = ws.sessionId;
    if (!sid) return;
    if (get().boundSid && get().boundSid !== sid) {
      set({ error: "Preview belongs to a previous sheet. Generate AI Preview again." });
      return;
    }
    const acceptMin = get().acceptMin;
    const allowed = Array.isArray(onlyOperationIds) ? new Set(onlyOperationIds) : null;
    const enabled = new Set(
      get().plan
        .filter((o) => o.enabled !== false || Boolean(allowed?.has(o.id)))
        .map((o) => o.id),
    );
    const kindOf = new Map(get().plan.map((o) => [o.id, o.kind]));
    const chosen = get().diffs.filter((d) => {
      if (allowed && !allowed.has(d.op_id)) return false;
      if (!enabled.has(d.op_id)) return false;
      if (d.status === "rejected") return false;
      if (d.suggested === d.original) return false;
      if (mode === "policy") return true;
      if (mode === "auto") {
        const conf = Number(d.confidence) || 0;
        return d.status === "accepted" || conf >= acceptMin || d.bucket === "auto";
      }
      return d.status === "accepted";
    });
    if (!chosen.length) {
      set({ error: "Nothing to apply. Accept cells or include auto-fix operations." });
      return;
    }
    set({ busy: true, error: "", phase: "apply", progress: "Applying one transaction…" });
    try {
      const ops = chosen.map((d) => ({
        column: d.column,
        row: d.row,
        original: d.original,
        suggested: d.suggested,
        confidence: d.confidence,
        kind: kindOf.get(d.op_id) || "ai",
      }));
      // Client already filtered. Pass 0 so hand-accepted cells below the bar still apply.
      const r = (await api.aiApply(sid, ops, 0)) as { highlights?: { row: number; column: string; stage: string }[]; changed?: number };
      const appliedKeys = new Set(chosen.map(diffKey));
      const highlights = dropReview(useWorkspace.getState().highlights);
      for (const h of r.highlights || []) {
        if (h && typeof h.row === "number" && h.column) highlights[`${h.row}:${h.column}`] = h.stage || "ai";
      }
      for (const k of appliedKeys) {
        if (!highlights[k]) highlights[k] = "ai";
      }
      useWorkspace.setState({ highlights, rowCache: {} });
      await ws.loadViewport(0);
      await ws.refresh();
      const cells = r.changed ?? chosen.length;
      set({
        phase: "idle",
        progress: `Applied ${cells.toLocaleString()} cells · one undo step`,
        diffs: get().diffs.map((d) => (appliedKeys.has(diffKey(d)) ? { ...d, status: "accepted" as const } : d)),
        history: [
          {
            id: `${Date.now()}`,
            ts: new Date().toISOString(),
            title:
              mode === "policy"
                ? "Apply pre-approved worker rules"
                : mode === "auto"
                  ? `Apply auto ≥${acceptPct(acceptMin)}%`
                  : "Apply accepted suggestions",
            cells,
          },
          ...get().history,
        ].slice(0, 20),
      });
    } catch (e) {
      set({ error: String(e), progress: "" });
    } finally {
      set({ busy: false });
    }
  },
}));
