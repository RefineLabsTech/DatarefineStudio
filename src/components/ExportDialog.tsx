import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Download, FileText, HardDrive } from "lucide-react";
import { useWorkspace } from "../store/workspace";
import { useUI } from "../store/ui";
import { api } from "../ipc/client";
import { usePlugins } from "../store/plugins";
import { useLicense } from "../store/license";
import { canUseFeature, PREMIUM_FEATURE } from "../license/features";

const FORMATS: { id: string; ext: string; label: string; hint: string }[] = [
  { id: "csv", ext: "csv", label: "CSV", hint: "Excel / Sheets" },
  { id: "xlsx", ext: "xlsx", label: "Excel", hint: "Workbook .xlsx" },
  { id: "tsv", ext: "tsv", label: "TSV", hint: "Tab separated" },
  { id: "json", ext: "json", label: "JSON", hint: "Array of rows" },
  { id: "ndjson", ext: "ndjson", label: "NDJSON", hint: "One row per line" },
  { id: "parquet", ext: "parquet", label: "Parquet", hint: "Columnar" },
  { id: "feather", ext: "feather", label: "Feather", hint: "Arrow IPC" },
  { id: "html", ext: "html", label: "HTML", hint: "Table" },
];

export function ExportDialog() {
  const { exportOpen, setExportOpen, sessionId, running, metrics, highlights } = useWorkspace(
    useShallow((s) => ({
      exportOpen: s.exportOpen,
      setExportOpen: s.setExportOpen,
      sessionId: s.sessionId,
      running: s.running,
      metrics: s.metrics,
      highlights: s.highlights,
    })),
  );
  const license = useLicense((s) => s.snap);
  const exportNonCsvAllowed = canUseFeature(license, PREMIUM_FEATURE.exportNonCsv);
  const askConfirm = useUI((s) => s.askConfirm);
  const plugExporters = usePlugins((s) => s.ui.exporters);
  const [fmt, setFmt] = useState("xlsx");
  const [name, setName] = useState("clean");
  const [folder, setFolder] = useState("exports");
  const [mode, setMode] = useState<"download" | "disk">("download");
  const [headers, setHeaders] = useState(true);
  const [withReport, setWithReport] = useState(true);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!exportNonCsvAllowed) {
      setFmt("csv");
      setWithReport(false);
    }
  }, [exportNonCsvAllowed]);

  if (!exportOpen) return null;

  const extraFmts = plugExporters
    .filter((e) => e.id || e.ext)
    .map((e) => ({
      id: String(e.id || e.ext),
      ext: String(e.ext || e.id),
      label: String(e.label || e.ext || e.id),
      hint: String(e.hint || e.extension || "plugin"),
    }));
  const allFmts = exportNonCsvAllowed ? [...FORMATS, ...extraFmts.filter((f) => !FORMATS.some((b) => b.id === f.id))] : FORMATS.slice(0, 1);
  const spec = allFmts.find((f) => f.id === fmt) || allFmts[0];
  const base = (name || "clean").replace(/\.[^.]+$/, "");
  const filename = `${base}.${spec.ext}`;
  const dest = `${folder.replace(/\/+$/, "")}/${filename}`;
  const reportName = `${base}-cleaning-report.pdf`;
  const cleaned = metrics?.cells_cleaned ?? Object.keys(highlights).length;
  const totalCells = (metrics?.rows || 0) * (metrics?.columns || 0);
  const pct = totalCells ? ((cleaned / totalCells) * 100).toFixed(1) : "0.0";

  const go = async () => {
    if (!sessionId) return;
    setMsg("");
    if (mode === "download" && withReport) {
      const allowed = await askConfirm({
        title: "Allow multiple downloads?",
        message: "DataRefine Studio is ready to save your cleaned data and PDF report.",
        detail: `2 files\n${filename}\n${reportName}\n\nThey will be saved to your Downloads folder.`,
        confirmLabel: "Allow downloads",
        cancelLabel: "Block",
      });
      if (!allowed) {
        setMsg("Download cancelled.");
        return;
      }
    }
    setBusy(true);
    try {
      if (mode === "download") {
        await api.download(sessionId, fmt, filename, { headers });
        if (withReport) await api.downloadReport(sessionId, reportName);
        setMsg(withReport ? "Data + PDF report downloading." : "Download started.");
      } else {
        const r = (await api.export(sessionId, fmt, dest, { headers })) as { path?: string };
        if (withReport) {
          await api.export(sessionId, "report-pdf", `${folder.replace(/\/+$/, "")}/${reportName}`);
        }
        setMsg(withReport ? `Saved ${r.path || dest} + ${reportName}` : `Saved ${r.path || dest}`);
      }
      window.setTimeout(() => setExportOpen(false), 700);
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 50,
        background: "rgba(6,8,12,0.62)",
        backdropFilter: "blur(8px)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
      }}
      onClick={() => setExportOpen(false)}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 520,
          maxWidth: "100%",
          borderRadius: 20,
          border: "1px solid var(--border)",
          background: "var(--bg-elev)",
          color: "var(--text)",
          padding: 22,
          display: "grid",
          gap: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.4)",
        }}
      >
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.03em" }}>Export cleaned data</div>
          <div style={{ fontSize: 12, color: "var(--text-dim)", marginTop: 4 }}>Pick a format, then download or save next to the app.</div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid var(--border)",
            background: "color-mix(in srgb, var(--ok) 12%, var(--bg))",
          }}
        >
          <FileText size={16} color="var(--ok)" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 700, fontSize: 13 }}>{cleaned.toLocaleString()} cells cleaned</div>
            <div style={{ fontSize: 11, color: "var(--text-dim)" }}>
              {totalCells ? `${pct}% of ${totalCells.toLocaleString()} cells` : "Run cleaning first"}
              {metrics ? ` · health ${metrics.health.toFixed(1)}` : ""}
            </div>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {allFmts.map((f) => {
            const on = fmt === f.id;
            return (
              <button
                key={f.id}
                type="button"
                onClick={() => setFmt(f.id)}
                style={{
                  textAlign: "left",
                  padding: "10px 10px 12px",
                  borderRadius: 12,
                  border: on ? "1px solid var(--accent)" : "1px solid var(--border)",
                  background: on ? "color-mix(in srgb, var(--accent) 16%, var(--bg))" : "var(--bg)",
                  color: "var(--text)",
                }}
              >
                <div style={{ fontWeight: 700, fontSize: 13 }}>{f.label}</div>
                <div style={{ fontSize: 10, color: "var(--text-dim)", marginTop: 2 }}>{f.hint}</div>
              </button>
            );
          })}
        </div>
        <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
          File name
          <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <button
            type="button"
            onClick={() => setMode("download")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: mode === "download" ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: mode === "download" ? "color-mix(in srgb, var(--accent) 14%, var(--bg))" : "var(--bg)",
              color: "var(--text)",
              textAlign: "left",
            }}
          >
            <Download size={16} />
            <span>
              <div style={{ fontWeight: 650, fontSize: 13 }}>Download</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Save in your Downloads folder</div>
            </span>
          </button>
          <button
            type="button"
            onClick={() => setMode("disk")}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: 12,
              borderRadius: 12,
              border: mode === "disk" ? "1px solid var(--accent)" : "1px solid var(--border)",
              background: mode === "disk" ? "color-mix(in srgb, var(--accent) 14%, var(--bg))" : "var(--bg)",
              color: "var(--text)",
              textAlign: "left",
            }}
          >
            <HardDrive size={16} />
            <span>
              <div style={{ fontWeight: 650, fontSize: 13 }}>Save on disk</div>
              <div style={{ fontSize: 11, color: "var(--text-dim)" }}>Write under the app folder</div>
            </span>
          </button>
        </div>
        {mode === "disk" && (
          <label style={{ display: "grid", gap: 6, fontSize: 12, color: "var(--text-dim)" }}>
            Folder
            <input className="field" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </label>
        )}
        {(fmt === "csv" || fmt === "tsv") && (
          <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: "var(--text-dim)" }}>
            <input type="checkbox" checked={headers} onChange={(e) => setHeaders(e.target.checked)} />
            Include header row
          </label>
        )}
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 12, color: exportNonCsvAllowed ? "var(--text)" : "var(--text-dim)" }}>
          <input type="checkbox" checked={withReport} disabled={!exportNonCsvAllowed} onChange={(e) => setWithReport(e.target.checked)} style={{ marginTop: 2 }} />
          <span>
            <b>Also PDF cleaning report{!exportNonCsvAllowed ? " · Professional" : ""}</b>
            <div style={{ fontSize: 11, color: "var(--text-dim)", marginTop: 2 }}>
              {exportNonCsvAllowed ? `${reportName} — cells cleaned, by column, by stage, health before/after` : "PDF and other non-CSV exports are disabled in Basic mode."}
            </div>
          </span>
        </label>
        <div
          style={{
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 11,
            padding: "8px 10px",
            borderRadius: 8,
            background: "var(--bg)",
            color: "var(--text-dim)",
          }}
        >
          {mode === "download" ? filename : dest}
          {withReport ? `  +  ${reportName}` : ""}
        </div>
        {msg && <div style={{ fontSize: 12, color: "var(--text-dim)" }}>{msg}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={() => setExportOpen(false)}
            style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid var(--border)", background: "transparent", color: "var(--text)" }}
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={busy || running || !sessionId}
            onClick={() => void go()}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "var(--accent)",
              color: "#fff",
              fontWeight: 650,
              opacity: busy || !sessionId ? 0.4 : 1,
            }}
          >
            {busy ? "Exporting…" : mode === "download" ? "Download" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}
