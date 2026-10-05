import { create } from "zustand";
import {
  nativeActivate,
  nativeBootstrap,
  nativeContinueBasic,
  nativeCheckNow,
  nativeRemoveLicense,
  nativeDismiss,
  nativeListen,
  nativeOpenUrl,
  nativeResume,
  nativeState,
} from "../license/native";
import type { Announcement, LicenseSnapshot } from "../license/types";

type LicenseStore = {
  snap: LicenseSnapshot | null;
  booted: boolean;
  busy: boolean;
  activateError: string;
  boot: () => Promise<void>;
  poll: () => Promise<void>;
  activate: (key: string) => Promise<boolean>;
  checkNow: () => Promise<void>;
  removeLicense: () => Promise<boolean>;
  resume: () => Promise<void>;
  dismiss: (a: Announcement) => Promise<void>;
  openUrl: (url: string) => Promise<void>;
  activationOpen: boolean;
  setActivationOpen: (open: boolean) => void;
  continueBasic: () => Promise<boolean>;
};

let polling = 0;

export const useLicense = create<LicenseStore>((set, get) => ({
  snap: null,
  booted: false,
  busy: false,
  activateError: "",
  activationOpen: false,
  setActivationOpen: (activationOpen) => set({ activationOpen }),

  continueBasic: async () => {
    set({ busy: true, activateError: "" });
    try {
      const snap = await nativeContinueBasic();
      if (snap) {
        set({ snap, busy: false, activationOpen: false });
        return snap.decision === "basic" || snap.decision === "granted";
      }
    } catch (e) {
      set({ activateError: String((e as Error)?.message || e) });
    }
    set({ busy: false });
    return false;
  },

  boot: async () => {
    if (get().booted) return;
    set({ booted: true });
    try {
      const snap = await nativeBootstrap();
      if (snap) set({ snap });
    } catch {
      /* Rust gate publishes its own state; keep splash until it answers */
    }
    if (!polling) {
      polling = window.setInterval(() => void get().poll(), 5000);
    }
    // §44: React reacts to Rust-emitted state changes (poll remains a safety net).
    nativeListen("license-state-changed", () => void get().poll());
    window.addEventListener("focus", () => void get().resume());
  },

  poll: async () => {
    try {
      const snap = await nativeState();
      if (snap) set({ snap });
    } catch {
      /* sidecar of the license state unavailable */
    }
  },

  activate: async (key: string) => {
    set({ busy: true, activateError: "" });
    try {
      const snap = await nativeActivate(key);
      if (snap) {
        set({ snap, busy: false, activationOpen: false });
        const ok = snap.decision === "granted" || snap.decision === "maintenance";
        if (!ok) set({ activateError: snap.message || "Activation failed." });
        return ok;
      }
      set({ busy: false, activateError: "No response from the license engine." });
      return false;
    } catch (e) {
      set({ busy: false, activateError: String((e as Error)?.message || e) });
      return false;
    }
  },

  checkNow: async () => {
    set({ busy: true });
    try {
      const snap = await nativeCheckNow();
      if (snap) set({ snap });
    } catch {
      /* ignore */
    }
    set({ busy: false });
  },

  removeLicense: async () => {
    set({ busy: true });
    try {
      const snap = await nativeRemoveLicense();
      if (snap) {
        set({ snap, busy: false });
        return snap.decision === "license_required";
      }
    } catch {
      /* keep the existing snapshot if the credential store refuses removal */
    }
    set({ busy: false });
    return false;
  },

  resume: async () => {
    try {
      const snap = await nativeResume();
      if (snap) set({ snap });
    } catch {
      /* ignore */
    }
  },

  dismiss: async (a: Announcement) => {
    const snap = await nativeDismiss(a.id, a.updatedAt || "");
    if (snap) set({ snap });
  },

  openUrl: async (url: string) => {
    await nativeOpenUrl(url);
  },
}));

/** Announcements that still deserve attention (not dismissed at current updatedAt). */
export function activeAnnouncements(snap: LicenseSnapshot | null): Announcement[] {
  if (!snap) return [];
  const dismissed = new Map(snap.dismissed.map((d) => [d.id, d.updatedAt]));
  return (snap.announcements || []).filter((a) => dismissed.get(a.id) !== (a.updatedAt || ""));
}
