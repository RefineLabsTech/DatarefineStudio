/* Thin Tauri bridge. All licensing logic/HTTP lives in Rust; React only
   sends intents and receives serialized snapshots. */

import type { LicenseSnapshot } from "./types";

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T | null> {
  try {
    const w = window as unknown as {
      __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<T> } };
      __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<T> };
    };
    const fn = w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
    if (typeof fn !== "function") return null;
    return await fn(cmd, args ?? {});
  } catch (e) {
    throw new Error(String((e as any)?.message || e));
  }
}

/** Subscribe to a Tauri event; returns an unsubscribe fn. Browser-safe. */
export async function nativeUpdateDownload(): Promise<string | null> {
  return invoke<string>("update_download");
}

export async function nativeAiCreditPurchase(source: string | null, byokConfigured: boolean): Promise<void> {
  await invoke("ai_credit_purchase", { source, byokConfigured });
}

export function nativeListen(event: string, handler: (payload: unknown) => void): () => void {
  try {
    const w = window as unknown as {
      __TAURI__?: { event?: { listen?: (e: string, cb: (ev: { payload?: unknown }) => void) => Promise<() => void> } };
    };
    const listen = w.__TAURI__?.event?.listen;
    if (typeof listen === "function") {
      let un: (() => void) | undefined;
      listen(event, (ev) => handler(ev?.payload)).then((u) => (un = u)).catch(() => {});
      return () => {
        try {
          un?.();
        } catch {
          /* already gone */
        }
      };
    }
  } catch {
    /* not running inside Tauri */
  }
  return () => {};
}

export async function nativeBootstrap(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_bootstrap");
}

export async function nativeState(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_state");
}

export async function nativeActivate(key: string): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_activate", { key });
}

export async function nativeContinueBasic(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_continue_basic");
}

export async function nativeRequireFeature(feature: string): Promise<void> {
  await invoke("license_require_feature", { feature });
}

export async function nativeCheckNow(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_check_now");
}

export async function nativeRemoveLicense(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_remove");
}

export async function nativeResume(): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_resume");
}

export async function nativeDismiss(id: string, updatedAt: string): Promise<LicenseSnapshot | null> {
  return invoke<LicenseSnapshot>("license_dismiss", { id, updatedAt });
}

export async function nativeOpenUrl(url: string): Promise<void> {
  await invoke("license_open_url", { url });
}

export async function nativeExit(): Promise<void> {
  try {
    const w = window as unknown as {
      __TAURI__?: { core?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } };
      __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> };
    };
    const fn = w.__TAURI__?.core?.invoke || w.__TAURI_INTERNALS__?.invoke;
    if (typeof fn === "function") await fn("win_close", {});
  } catch {
    window.close();
  }
}
