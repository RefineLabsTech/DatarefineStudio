/* Serialized license state — produced by Rust, rendered by React.
   React never performs licensing HTTP itself. */

export type Announcement = {
  id: string;
  type: "info" | "warning" | "critical" | string;
  title?: string | null;
  message?: string | null;
  updatedAt?: string | null;
  link?: string | null;
  enabled?: boolean;
  audience?: unknown;
  startDate?: string | null;
  endDate?: string | null;
  dismissible?: boolean;
  priority?: number;
  buttonText?: string | null;
  buttonUrl?: string | null;
};

export type RemoteConfig = {
  product?: string | null;
  /** New cloud deployments may expose this at the top level. */
  requireLicense?: boolean;
  enableAiCreditPurchase?: boolean;
  aiCreditPurchaseUrl?: string | null;
  /** Legacy/reference cloud config may expose the upgrade URL at top level. */
  buyUrl?: string | null;
  licensing: {
    requireLicense: boolean;
    verifyIntervalHours: number;
    offlineGraceDays: number;
    enableAiCreditPurchase?: boolean;
    aiCreditPurchaseUrl?: string | null;
    features?: unknown;
    premiumFeatures?: unknown;
    limits?: unknown;
  };
  maintenance: { enabled: boolean; message?: string | null; hard?: boolean };
  links: { buyUrl?: string | null; githubUrl?: string | null; supportEmail?: string | null; docsUrl?: string | null };
  versions: { latest?: string | null; minimum?: string | null; downloadUrl?: string | null; releaseNotes?: string | null };
  announcements: Announcement[];
  features?: unknown;
  premiumFeatures?: unknown;
  limits?: unknown;
};

export type LicenseView = {
  plan: string;
  masked: string;
  expiresAt: string;
  daysRemaining: number;
  lastVerification?: string | null;
  offline: boolean;
};

export type UpdateView = {
  current: string;
  latest: string;
  minimum: string;
  mandatory: boolean;
  downloadUrl: string;
  windowsDownloadUrl?: string;
  linuxDownloadUrl?: string;
  sha256?: string;
  releaseNotes: string;
};

export type Dismissed = { id: string; updatedAt: string };

export type LicenseEntitlements = {
  cloudAi: boolean;
  aiPlugins: boolean;
  agents: boolean;
  capabilities: string[];
};

export type FeaturePolicy = {
  premiumFeatures: string[];
  basicImportRowLimit: number;
};

export type LicenseSnapshot = {
  stage: "booting" | "ready" | string;
  decision:
    | "granted"
    | "basic"
    | "maintenance"
    | "mandatory_update"
    | "license_required"
    | "license_invalid"
    | "license_blocked"
    | "license_expired"
    | "device_mismatch"
    | "token_invalid"
    | "grace_expired"
    | string;
  message?: string | null;
  offline: boolean;
  requireLicense: boolean;
  config?: RemoteConfig | null;
  license?: LicenseView | null;
  announcements: Announcement[];
  update?: UpdateView | null;
  deviceId: string;
  dismissed: Dismissed[];
  entitlements?: LicenseEntitlements;
  featurePolicy?: FeaturePolicy;
  basicMode?: boolean;
  endpoint?: { url: string; source: "bootstrap" | "cached" | "stable"; configVersion: number } | null;
  /** Rust-owned enforcement posture: "unrestricted" | "licensed". */
  enforcement?: "unrestricted" | "licensed";
  lastCheck?: string | null;
  error?: string | null;
};
