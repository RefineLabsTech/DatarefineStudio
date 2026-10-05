import type { LicenseSnapshot } from "./types";

export const PREMIUM_FEATURE = {
  connectDb: "connect_db",
  push: "push",
  importLarge: "import_large",
  exportNonCsv: "export_non_csv",
  marketplace: "marketplace",
  pluginInstall: "plugin_install",
  installedPlugins: "installed_plugins",
  premiumDataWorkflows: "premium_data_workflows",
} as const;

export const DEFAULT_BASIC_IMPORT_ROW_LIMIT = 5000;

const DEFAULT_PREMIUM_FEATURES = new Set<string>([
  PREMIUM_FEATURE.connectDb,
  PREMIUM_FEATURE.push,
  PREMIUM_FEATURE.importLarge,
  PREMIUM_FEATURE.exportNonCsv,
  PREMIUM_FEATURE.marketplace,
  PREMIUM_FEATURE.pluginInstall,
  PREMIUM_FEATURE.installedPlugins,
  PREMIUM_FEATURE.premiumDataWorkflows,
]);

function canonicalFeature(raw: string) {
  const compact = String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    connectdb: PREMIUM_FEATURE.connectDb,
    databaseconnect: PREMIUM_FEATURE.connectDb,
    databaseconnection: PREMIUM_FEATURE.connectDb,
    push: PREMIUM_FEATURE.push,
    datapush: PREMIUM_FEATURE.push,
    pushdatabase: PREMIUM_FEATURE.push,
    importlarge: PREMIUM_FEATURE.importLarge,
    largeimport: PREMIUM_FEATURE.importLarge,
    importover5000: PREMIUM_FEATURE.importLarge,
    rowsabove5000: PREMIUM_FEATURE.importLarge,
    exportnoncsv: PREMIUM_FEATURE.exportNonCsv,
    noncsvexport: PREMIUM_FEATURE.exportNonCsv,
    exportformats: PREMIUM_FEATURE.exportNonCsv,
    export: PREMIUM_FEATURE.exportNonCsv,
    marketplace: PREMIUM_FEATURE.marketplace,
    pluginmarketplace: PREMIUM_FEATURE.marketplace,
    plugininstall: PREMIUM_FEATURE.pluginInstall,
    installplugins: PREMIUM_FEATURE.pluginInstall,
    installedplugins: PREMIUM_FEATURE.installedPlugins,
    marketplaceplugins: PREMIUM_FEATURE.installedPlugins,
    plugins: PREMIUM_FEATURE.installedPlugins,
    premiumdataworkflows: PREMIUM_FEATURE.premiumDataWorkflows,
    premiumworkflows: PREMIUM_FEATURE.premiumDataWorkflows,
  };
  return aliases[compact] || String(raw || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

export function isLicenseRequired(snap: LicenseSnapshot | null | undefined) {
  return Boolean(snap?.requireLicense && snap.enforcement !== "unrestricted");
}

export function hasProfessionalAccess(snap: LicenseSnapshot | null | undefined) {
  // A deployment with licensing switched off is intentionally unrestricted.
  // A temporary unrestricted posture caused by a licensing-disabled response
  // still has requireLicense=true, so its paid/cloud-controlled features stay
  // unavailable until the cloud policy is re-enabled.
  if (!snap?.requireLicense) return true;
  return snap.enforcement === "licensed" && snap.decision === "granted";
}

/** Returns true when a feature is available in the current cloud-controlled mode. */
export function canUseFeature(snap: LicenseSnapshot | null | undefined, feature: string) {
  if (!snap?.requireLicense) return true;
  const configured = snap.featurePolicy?.premiumFeatures;
  const premium = Array.isArray(configured)
    ? new Set(configured.map(canonicalFeature).filter(Boolean))
    : DEFAULT_PREMIUM_FEATURES;
  if (!premium.has(canonicalFeature(feature)) && !premium.has("all")) return true;
  return hasProfessionalAccess(snap);
}

export function basicImportRowLimit(snap: LicenseSnapshot | null | undefined) {
  const value = Number(snap?.featurePolicy?.basicImportRowLimit);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_BASIC_IMPORT_ROW_LIMIT;
}

export function effectiveImportRowLimit(snap: LicenseSnapshot | null | undefined, requested: number) {
  if (canUseFeature(snap, PREMIUM_FEATURE.importLarge)) return requested;
  const limit = basicImportRowLimit(snap);
  if (!Number.isFinite(requested) || requested <= 0) return limit;
  return Math.min(Math.floor(requested), limit);
}

export function featureLabel(feature: string) {
  return feature
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
