import {
  AlbedoModule,
  ALBEDO_ID,
  FreighterModule,
  FREIGHTER_ID,
  LobstrModule,
  LOBSTR_ID,
  StellarWalletsKit,
  WalletNetwork,
  xBullModule,
  XBULL_ID,
} from "@creit.tech/stellar-wallets-kit";

import type { UiNetwork } from "./network.js";

let activeKit: StellarWalletsKit | null = null;
let activeNetwork: UiNetwork | null = null;
let selectedWalletId = FREIGHTER_ID;

function kitNetwork(ui: UiNetwork): WalletNetwork {
  return ui === "mainnet" ? WalletNetwork.PUBLIC : WalletNetwork.TESTNET;
}

async function buildModules(uiNetwork: UiNetwork) {
  const modules = [new FreighterModule(), new AlbedoModule(), new xBullModule(), new LobstrModule()];
  const wc = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
  if (wc) {
    const { WalletConnectAllowedMethods, WalletConnectModule } = await import(
      "@creit.tech/stellar-wallets-kit/modules/walletconnect.module"
    );
    modules.push(
      new WalletConnectModule({
        projectId: wc,
        name: "Account Demolisher",
        description: "Sign classic Stellar transactions to close offers and LP before account merge.",
        url: typeof window !== "undefined" ? window.location.origin : "http://localhost",
        icons: [],
        method: WalletConnectAllowedMethods.SIGN,
        network: kitNetwork(uiNetwork),
      }),
    );
  }
  return modules;
}

export async function ensureWalletKit(uiNetwork: UiNetwork): Promise<StellarWalletsKit> {
  if (activeKit && activeNetwork === uiNetwork) return activeKit;

  activeKit = new StellarWalletsKit({
    selectedWalletId,
    network: kitNetwork(uiNetwork),
    modules: await buildModules(uiNetwork),
  });
  activeNetwork = uiNetwork;
  return activeKit;
}

export async function connectWallet(uiNetwork: UiNetwork): Promise<{ address: string }> {
  const kit = await ensureWalletKit(uiNetwork);

  return new Promise<{ address: string }>((resolve, reject) => {
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    void kit.openModal({
      modalTitle: "Choose a Stellar wallet",
      onWalletSelected: (wallet) => {
        void (async () => {
          try {
            selectedWalletId = wallet.id || selectedWalletId;
            kit.setWallet(selectedWalletId);
            const result = await kit.getAddress();
            finish(() => resolve(result));
          } catch (error) {
            finish(() => reject(error));
          }
        })();
      },
      onClosed: (error) => {
        finish(() => reject(error ?? new Error("Wallet selection cancelled.")));
      },
    });
  });
}

export async function disconnectWallet(uiNetwork: UiNetwork): Promise<void> {
  const kit = await ensureWalletKit(uiNetwork);
  await kit.disconnect();
}

export async function signWithWallet(
  uiNetwork: UiNetwork,
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string; path?: string; submit?: boolean; submitUrl?: string },
) {
  const kit = await ensureWalletKit(uiNetwork);
  return kit.signTransaction(xdr, opts);
}

/** Human-readable message for kit / modal errors (`{ code, message }` or `Error`). */
export function formatWalletError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  if (e instanceof Error) return e.message;
  return "Wallet action failed.";
}

export const availableWalletIds = {
  albedo: ALBEDO_ID,
  freighter: FREIGHTER_ID,
  lobstr: LOBSTR_ID,
  xbull: XBULL_ID,
};
