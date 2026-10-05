import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { ErrorBoundary } from "./app/ErrorBoundary";
import { App } from "./app/App";
import { useLicense } from "./store/license";
import { SplashScreen } from "./components/startup/SplashScreen";
import { MaintenanceScreen } from "./components/maintenance/MaintenanceScreen";
import { LicenseActivationDialog } from "./components/license/LicenseActivationDialog";
import { AnnouncementBanner } from "./components/announcement/AnnouncementBanner";
import { MaintenanceBanner } from "./components/maintenance/MaintenanceBanner";
import { AnnouncementModal } from "./components/announcement/AnnouncementModal";
import { datarefineAi } from "./services/ai";
import { refreshAiUsage } from "./services/aiQuota";
import { UpdateDialog, MandatoryUpdateScreen } from "./components/update/UpdateDialog";

const client = new QueryClient();

const LOCK_DECISIONS = new Set([
  "license_required",
  "license_invalid",
  "license_blocked",
  "license_expired",
  "device_mismatch",
  "token_invalid",
  "grace_expired",
]);

/** Startup gate: nothing renders until the Rust gate resolves.
    Priority: maintenance → license toggle/verification → announcements → app. */
function Gate() {
  const snap = useLicense((s) => s.snap);
  const activationOpen = useLicense((s) => s.activationOpen);
  const boot = useLicense((s) => s.boot);
  useEffect(() => {
    void boot();
  }, [boot]);
  // The static #boot-splash from index.html is opaque and sits above React.
  // Once React is alive, our own splash/gate owns the screen — drop the static one.
  useEffect(() => {
    document.getElementById("boot-splash")?.remove();
  }, []);

  useEffect(() => {
    if (!snap || snap.stage !== "ready" || !snap.requireLicense || snap.enforcement === "unrestricted") return;
    let cancelled = false;
    const refreshServerState = async () => {
      const decision = await datarefineAi.router();
      if (cancelled) return;
      if (decision.source === "cloud") {
        // Settings and Cloud jobs perform their own refreshes too; this startup
        // read keeps the wallet current without inventing a local deduction.
        await datarefineAi.getCredits("cloud").catch(() => null);
      }
      await refreshAiUsage(decision.source);
    };
    void refreshServerState();
    return () => {
      cancelled = true;
    };
  }, [snap?.stage, snap?.requireLicense, snap?.enforcement, snap?.decision]);

  if (!snap || snap.stage !== "ready") return <SplashScreen />;
  if (snap.decision === "maintenance") return <MaintenanceScreen />;
  if (snap.decision === "mandatory_update") return <MandatoryUpdateScreen />;
  if (LOCK_DECISIONS.has(snap.decision) || (snap.decision === "basic" && activationOpen)) return <LicenseActivationDialog />;
  return (
    <>
      <MaintenanceBanner />
      <AnnouncementBanner />
      <AnnouncementModal />
      <UpdateDialog />
      <App />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <ErrorBoundary>
      <Gate />
    </ErrorBoundary>
  </QueryClientProvider>,
);
