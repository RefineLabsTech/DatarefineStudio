import { create } from "zustand";
import { api, type GithubAccount, type GithubDeviceStart } from "../ipc/client";

type Auth = {
  account: GithubAccount;
  authOpen: boolean;
  setAuthOpen: (v: boolean) => void;
  refresh: () => Promise<void>;
  startDevice: () => Promise<GithubDeviceStart>;
  pollDevice: (deviceId: string) => Promise<{ status: string; message?: string; interval?: number; github?: GithubAccount }>;
  signInToken: (token: string) => Promise<void>;
  signOut: (accountId?: string) => Promise<void>;
  switchAccount: (accountId: string) => Promise<void>;
  saveClientId: (clientId: string) => Promise<void>;
};

const empty: GithubAccount = {
  client_id: "",
  signed_in: false,
  has_token: false,
  user: null,
  scope: "",
  method: "",
  active_id: "",
  accounts: [],
};

export const useAuth = create<Auth>((set) => ({
  account: empty,
  authOpen: false,
  setAuthOpen: (authOpen) => set({ authOpen }),
  refresh: async () => {
    try {
      const account = await api.githubMe();
      set({ account });
    } catch {
      /* sidecar down */
    }
  },
  startDevice: () => api.githubStart(),
  pollDevice: (deviceId) => api.githubPoll(deviceId),
  signInToken: async (token) => {
    const account = await api.githubToken(token);
    set({ account });
  },
  signOut: async (accountId) => {
    const account = await api.githubSignOut(accountId);
    set({ account });
  },
  switchAccount: async (accountId) => {
    const account = await api.githubSwitch(accountId);
    set({ account });
  },
  saveClientId: async (clientId) => {
    const account = await api.githubClientId(clientId);
    set({ account });
  },
}));
