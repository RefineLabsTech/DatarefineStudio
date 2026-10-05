import { create } from "zustand";
import { api } from "../ipc/client";
import type { LibRule } from "../lib/builtinRules";
import { defaultEnabled, mergeUniversal, toUniversalPayload, type UniRule } from "../lib/universalRules";

type State = {
  enabled: Record<string, boolean>;
  loaded: boolean;
  load: () => Promise<void>;
  isOn: (key: string) => boolean;
  setOn: (key: string, on: boolean) => Promise<void>;
  catalog: (library: LibRule[]) => UniRule[];
  payloads: (library: LibRule[]) => Record<string, unknown>[];
};

export const useUniversal = create<State>((set, get) => ({
  enabled: {},
  loaded: false,
  load: async () => {
    try {
      const s = await api.settings();
      const enabled = (s.universal_enabled as Record<string, boolean>) || {};
      set({ enabled, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },
  isOn: (key) => {
    const m = get().enabled;
    if (Object.prototype.hasOwnProperty.call(m, key)) return Boolean(m[key]);
    return defaultEnabled(key);
  },
  setOn: async (key, on) => {
    const enabled = { ...get().enabled, [key]: on };
    set({ enabled });
    try {
      await api.saveSettings({ universal_enabled: enabled });
    } catch {
      /* sidecar down */
    }
  },
  catalog: (library) => mergeUniversal(library),
  payloads: (library) => {
    const st = get();
    return mergeUniversal(library)
      .filter((r) => st.isOn(r.key))
      .map(toUniversalPayload);
  },
}));
