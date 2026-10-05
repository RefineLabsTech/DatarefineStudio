/* Dedicated Marketplace side panel — search & install plugins.
   Marketplace browsing and installs are Professional features when the cloud
   policy enables licensing. Remote installs still require a trusted
   HTTPS/loopback artifact URL and a matching sha256; first-party development
   artifacts can use the local catalog. */

import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ArrowLeft, ExternalLink, RefreshCw, Search, Store, X } from "lucide-react";
import { pluginIcon } from "../lib/pluginIcons";
import { openUrl, tauriInvokeStrict } from "../ipc/client";
import { usePlugins } from "../store/plugins";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";
import { PremiumFeatureGate } from "../components/license/PremiumFeatureGate";

type MarketEntry = {
  id: string;
  name: string;
  version: string;
  summary?: string | null;
  description: string;
  author: string;
  icon?: string | null;
  category?: string | null;
  capabilities?: string[];
  homepage?: string | null;
  minAppVersion?: string | null;
  entitled: boolean;
  downloads?: number;
  sha256?: string | null;
  artifactUrl?: string | null;
  // The catalogue may provide an ISO date or a millisecond/second epoch.
  // The Rust marketplace bridge normalizes createdAt/published_at aliases to this field.
  publishedAt?: string | number | null;
};
type MarketResult = { available: boolean; reason?: string | null; results: MarketEntry[] };
const MARKET_CACHE_KEY = "datarefine.marketplace.catalog.v3";

function readMarketplaceCache(): MarketResult | null {
  try {
    const raw = localStorage.getItem(MARKET_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { market?: MarketResult };
    return parsed.market?.available && Array.isArray(parsed.market.results) ? parsed.market : null;
  } catch {
    return null;
  }
}

function writeMarketplaceCache(market: MarketResult) {
  if (!market.available) return;
  try {
    localStorage.setItem(MARKET_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), market }));
  } catch {
    /* ignore storage quota/private mode */
  }
}

function publishedTime(entry: MarketEntry) {
  const raw = entry.publishedAt;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 1_000_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string") {
    const value = raw.trim();
    if (!value) return null;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** Keep the newest publication as the first card; the remaining catalogue is
 * easy to scan alphabetically. If an older catalogue omits dates, its existing
 * first result is treated as the newest result. */
function orderedMarketResults(results: MarketEntry[]) {
  if (results.length < 2) return results;
  const indexed = results.map((entry, index) => ({ entry, index, time: publishedTime(entry) }));
  let newest = indexed[0];
  for (const item of indexed.slice(1)) {
    if (item.time != null && (newest.time == null || item.time > newest.time)) newest = item;
  }
  const rest = indexed
    .filter((item) => item !== newest)
    .sort((a, b) =>
      String(a.entry.name || a.entry.id).localeCompare(String(b.entry.name || b.entry.id), undefined, {
        sensitivity: "base",
        numeric: true,
      }),
    );
  return [newest.entry, ...rest.map((item) => item.entry)];
}

function searchableText(entry: MarketEntry) {
  return [
    entry.name,
    entry.id,
    entry.summary,
    entry.description,
    entry.author,
    entry.category,
    ...(entry.capabilities || []),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** VS Code-style local search: every term must match somewhere, with name and
 * id matches ranked above description/capability matches. */
function searchMarketResults(entries: MarketEntry[], query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return orderedMarketResults(entries);
  const scored = entries.flatMap((entry) => {
    const name = String(entry.name || "").toLowerCase();
    const id = String(entry.id || "").toLowerCase();
    const text = searchableText(entry);
    if (!terms.every((term) => text.includes(term))) return [];
    let score = 0;
    for (const term of terms) {
      if (name === term) score += 1000;
      else if (name.startsWith(term)) score += 800;
      else if (name.includes(term)) score += 600;
      else if (id.startsWith(term)) score += 500;
      else if (id.includes(term)) score += 350;
      else score += 100;
    }
    return [{ entry, score }];
  });
  return scored
    .sort((a, b) =>
      b.score - a.score ||
      String(a.entry.name || a.entry.id).localeCompare(String(b.entry.name || b.entry.id), undefined, { sensitivity: "base", numeric: true }),
    )
    .map((item) => item.entry);
}

const card: React.CSSProperties = {
  borderRadius: 12,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  padding: 12,
  display: "grid",
  gap: 8,
};
const compactCard: React.CSSProperties = {
  borderRadius: 10,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  padding: 10,
  display: "grid",
  gridTemplateColumns: "32px minmax(0, 1fr)",
  alignItems: "start",
  rowGap: 8,
  columnGap: 10,
  cursor: "pointer",
  minWidth: 0,
  overflow: "hidden",
};
const dimTxt: React.CSSProperties = { fontSize: 11, color: "var(--text-dim)" };
const ghostBtn: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: 8,
  border: "1px solid var(--border)",
  background: "transparent",
  color: "var(--text)",
  fontSize: 11,
  cursor: "pointer",
};
const primaryBtn: React.CSSProperties = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "none",
  background: "var(--accent)",
  color: "#fff",
  fontSize: 11,
  fontWeight: 600,
  cursor: "pointer",
};
const chip = (color: string): React.CSSProperties => ({
  fontSize: 10,
  padding: "2px 7px",
  borderRadius: 99,
  background: `color-mix(in srgb, ${color} 14%, transparent)`,
  color,
  border: `1px solid color-mix(in srgb, ${color} 30%, transparent)`,
  fontWeight: 700,
  whiteSpace: "nowrap",
});

export function MarketplacePage() {
  const { plugins, refresh } = usePlugins(useShallow((s) => ({ plugins: s.plugins, refresh: s.refresh })));
  const license = useLicense((s) => s.snap);
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState<MarketResult | null>(() => readMarketplaceCache());
  const [searching, setSearching] = useState(false);
  const [installing, setInstalling] = useState("");
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState<MarketEntry | null>(null);

  const refreshCatalogue = async () => {
    setSearching(true);
    try {
      // One catalogue request only. Search and sorting happen in memory.
      const result = await tauriInvokeStrict<MarketResult>("plugin_marketplace_search", { query: "" });
      setMarket(result);
      writeMarketplaceCache(result);
    } catch (errorValue) {
      // Keep a cached catalogue visible if the background refresh is offline.
      if (!market) setMarket({ available: false, reason: String(errorValue), results: [] });
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    if (!canUseFeature(license, PREMIUM_FEATURE.marketplace)) return;
    void refreshCatalogue();
    // Initial load only. Query changes never hit the network.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [license?.decision, license?.requireLicense, license?.enforcement]);

  const installedIds = new Set(plugins.map((p) => p.id));
  const isInstalled = (id: string) => installedIds.has(id) || installedIds.has(`datarefine.${id}`);
  const allResults = market?.available ? market.results : [];
  const filteredResults = useMemo(() => searchMarketResults(allResults, query), [allResults, query]);
  const latestId = useMemo(() => orderedMarketResults(allResults)[0]?.id || "", [allResults]);
  const selectedIsLatest = Boolean(selected && latestId === selected.id);

  if (!canUseFeature(license, PREMIUM_FEATURE.marketplace)) {
    return <PremiumFeatureGate feature={PREMIUM_FEATURE.marketplace} title="Marketplace is unavailable in Basic mode" description="Local files and cleaning remain available. Activate Professional to browse, install, or use Marketplace extensions." />;
  }

  const install = async (e: MarketEntry) => {
    setInstalling(e.id);
    setMsg("");
    try {
      await tauriInvokeStrict("plugin_install", { root: "plugins", id: e.id });
      setMsg(`Installed ${e.name || e.id} — checksum verified.`);
      await refresh();
    } catch (err) {
      setMsg(String((err as Error)?.message || err));
    } finally {
      setInstalling("");
    }
  };

  if (selected) {
    return (
      <MarketplaceDetail
        entry={selected}
        latest={selectedIsLatest}
        installed={isInstalled(selected.id)}
        installing={installing === selected.id}
        onBack={() => setSelected(null)}
        onInstall={(entry) => void install(entry)}
      />
    );
  }

  return (
    <div style={{ padding: 16, fontSize: 13, color: "var(--text)", display: "grid", gap: 12 }}>
      <div>
        <h1 style={{ fontSize: 16, fontWeight: 650, margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <Store size={16} style={{ color: "var(--accent)" }} /> Marketplace
        </h1>
        <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--text-dim)", lineHeight: 1.45 }}>
          Search by plugin name, ID, publisher, capability, or keyword. Results update instantly across the complete catalogue; every package is checksum-verified before it loads.
        </p>
      </div>

      <div role="search" style={{ display: "grid", gap: 7 }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div style={{ position: "relative", flex: 1 }}>
            <span
              aria-hidden="true"
              style={{
                position: "absolute",
                left: 9,
                top: "50%",
                transform: "translateY(-50%)",
                width: 16,
                height: 16,
                color: "var(--text-dim)",
                display: "grid",
                placeItems: "center",
                lineHeight: 0,
                pointerEvents: "none",
              }}
            >
              <Search size={13} />
            </span>
            <input
              className="field"
              aria-label="Search marketplace plugins"
              placeholder="Search extensions by name…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setQuery("");
              }}
              style={{ paddingLeft: 28, paddingRight: query ? 32 : 10, width: "100%", boxSizing: "border-box" }}
            />
            {query && (
              <button
                type="button"
                aria-label="Clear marketplace search"
                title="Clear search"
                onClick={() => setQuery("")}
                style={{ position: "absolute", right: 5, top: "50%", transform: "translateY(-50%)", width: 24, height: 24, display: "grid", placeItems: "center", border: "none", borderRadius: 6, background: "transparent", color: "var(--text-dim)", cursor: "pointer" }}
              >
                <X size={13} />
              </button>
            )}
          </div>
          <button type="button" style={{ ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 5 }} title="Refresh catalogue" onClick={() => void refreshCatalogue()}>
            <RefreshCw size={12} />
            <span style={{ display: "none" }}>Refresh</span>
          </button>
        </div>
        {market?.available && !searching && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--text-dim)" }}>
            <span style={{ fontWeight: 650, color: "var(--text)" }}>{filteredResults.length.toLocaleString()} result{filteredResults.length === 1 ? "" : "s"}</span>
            {query ? <span>for “{query}” · {allResults.length.toLocaleString()} total plugins</span> : <span>· all published plugins</span>}
          </div>
        )}
      </div>

      {market && !market.available && (
        <div style={{ ...card, gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 650 }}>Marketplace unavailable</div>
          <div style={dimTxt}>{market.reason || "The plugin catalogue could not be reached."}</div>
          <div>
            <button type="button" style={ghostBtn} onClick={() => void refreshCatalogue()}>
              Retry
            </button>
          </div>
        </div>
      )}

      {market?.available && searching && <div style={dimTxt}>Refreshing catalogue…</div>}

      {market?.available && !searching && filteredResults.length === 0 && (
        <div style={dimTxt}>{query ? `No marketplace plugins match “${query}”. Try a shorter name or a capability keyword.` : "No marketplace plugins are published yet."}</div>
      )}

      {market?.available &&
        filteredResults.map((e) => {
          const Icon = pluginIcon(e.icon || undefined);
          const has = isInstalled(e.id);
          const summary = e.summary || e.description || "No summary provided.";
          return (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              aria-label={`Open details for ${e.name || e.id}`}
              style={compactCard}
              onClick={() => setSelected(e)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setSelected(e);
                }
              }}
            >
              <span
                style={{
                  color: "var(--accent)",
                  display: "grid",
                  placeItems: "center",
                  width: 32,
                  height: 32,
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--accent) 25%, var(--border))",
                  flexShrink: 0,
                }}
              >
                <Icon size={16} />
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <span style={{ fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {e.name || e.id}
                  </span>
                  {e.id === latestId && <span style={chip("var(--accent)")}>Latest</span>}
                  <span style={{ ...dimTxt, whiteSpace: "nowrap" }}>v{e.version || "—"}</span>
                  <span style={{ ...dimTxt, whiteSpace: "nowrap" }}>
                    {typeof e.downloads === "number" ? `${e.downloads.toLocaleString()} installs` : "installs —"}
                  </span>
                </div>
                <div style={{ ...dimTxt, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {summary}
                </div>
              </div>
              <div style={{ gridColumn: "2", minWidth: 0, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                {has ? <span style={chip("var(--ok, #22c55e)")}>Installed</span> : null}
                {!has ? (
                  <button
                    type="button"
                    style={{ ...primaryBtn, padding: "5px 9px", opacity: installing === e.id ? 0.55 : 1 }}
                    disabled={installing === e.id}
                    onClick={(event) => {
                      event.stopPropagation();
                      void install(e);
                    }}
                  >
                    {installing === e.id ? "…" : "Install"}
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}

      {msg && <div style={dimTxt}>{msg}</div>}
      {installing && <div style={dimTxt}>downloading & verifying package…</div>}
    </div>
  );
}

function MarketplaceDetail({
  entry,
  latest,
  installed,
  installing,
  onBack,
  onInstall,
}: {
  entry: MarketEntry;
  latest: boolean;
  installed: boolean;
  installing: boolean;
  onBack: () => void;
  onInstall: (entry: MarketEntry) => void;
}) {
  const Icon = pluginIcon(entry.icon || undefined);
  const summary = entry.summary || entry.description || "No summary provided.";
  const capabilities = entry.capabilities || [];
  return (
    <div style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", color: "var(--text)" }}>
      <div style={{ padding: "10px 14px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        <button type="button" style={{ ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 6 }} onClick={onBack}>
          <ArrowLeft size={13} /> Back to Marketplace
        </button>
      </div>
      <div style={{ padding: 16, overflow: "auto", display: "grid", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
          <span
            style={{
              color: "var(--accent)",
              display: "grid",
              placeItems: "center",
              width: 46,
              height: 46,
              borderRadius: 11,
              background: "color-mix(in srgb, var(--accent) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
              flexShrink: 0,
            }}
          >
            <Icon size={23} />
          </span>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <h1 style={{ fontSize: 18, lineHeight: 1.2, margin: 0 }}>{entry.name || entry.id}</h1>
              {latest && <span style={chip("var(--accent)")}>Latest</span>}
            </div>
            <div style={{ ...dimTxt, marginTop: 6 }}>
              {entry.author ? `by ${entry.author} · ` : ""}v{entry.version || "—"}
              {entry.category ? ` · ${entry.category}` : ""}
            </div>
          </div>
        </div>

        <section style={detailSection}>
          <div style={detailHeading}>Summary</div>
          <div style={{ fontSize: 13, lineHeight: 1.55 }}>{summary}</div>
        </section>

        <section style={detailSection}>
          <div style={detailHeading}>Details</div>
          <div style={{ display: "grid", gap: 8 }}>
            <DetailRow label="Plugin ID" value={entry.id} />
            <DetailRow label="Version" value={entry.version || "—"} />
            {entry.minAppVersion ? <DetailRow label="Requires DataRefine" value={entry.minAppVersion} /> : null}
            <DetailRow label="Installs" value={typeof entry.downloads === "number" ? entry.downloads.toLocaleString() : "Not published"} />
          </div>
        </section>

        {entry.description && entry.description !== summary ? (
          <section style={detailSection}>
            <div style={detailHeading}>Description</div>
            <div style={{ fontSize: 12, color: "var(--text-dim)", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>{entry.description}</div>
          </section>
        ) : null}

        {capabilities.length ? (
          <section style={detailSection}>
            <div style={detailHeading}>Capabilities</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {capabilities.map((capability) => <span key={capability} style={capabilityChip}>{capability.replace(/_/g, " ")}</span>)}
            </div>
          </section>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {installed ? <span style={chip("var(--ok, #22c55e)")}>Installed</span> : null}
          {!installed ? (
            <button
              type="button"
              style={{ ...primaryBtn, opacity: installing ? 0.55 : 1 }}
              disabled={installing}
              onClick={() => onInstall(entry)}
            >
              {installing ? "Installing…" : "Install extension"}
            </button>
          ) : null}
          {entry.homepage ? (
            <button
              type="button"
              onClick={() => void openUrl(entry.homepage || "")}
              style={{ ...ghostBtn, display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              Homepage <ExternalLink size={12} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 11 }}>
      <span style={{ color: "var(--text-dim)" }}>{label}</span>
      <span style={{ textAlign: "right", wordBreak: "break-word" }}>{value}</span>
    </div>
  );
}

const detailSection: React.CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 11,
  display: "grid",
  gap: 8,
  background: "var(--bg)",
};

const detailHeading: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 750,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: "var(--text-dim)",
};

const capabilityChip: React.CSSProperties = {
  fontSize: 10,
  padding: "3px 7px",
  borderRadius: 99,
  background: "var(--bg-input)",
  color: "var(--text-dim)",
  border: "1px solid var(--border)",
};
