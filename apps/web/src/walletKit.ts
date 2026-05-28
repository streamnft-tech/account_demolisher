import { Networks, StellarWalletsKit } from "@creit.tech/stellar-wallets-kit";
import {
  WalletConnectModule,
  type TWalletConnectModuleParams,
  WalletConnectTargetChain,
} from "@creit.tech/stellar-wallets-kit/modules/wallet-connect";
import { defaultModules } from "@creit.tech/stellar-wallets-kit/modules/utils";
import type { ModuleInterface } from "@creit.tech/stellar-wallets-kit/types";

import type { UiNetwork } from "./network.js";

let activeNetwork: UiNetwork | null = null;

function kitNetwork(ui: UiNetwork): Networks {
  return ui === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

async function buildModules(uiNetwork: UiNetwork): Promise<ModuleInterface[]> {
  const modules: ModuleInterface[] = [...defaultModules()];
  const wc = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
  if (wc) {
    const metadata: TWalletConnectModuleParams["metadata"] = {
      name: "Account Demolisher",
      description: "Sign classic Stellar transactions to close offers and LP before account merge.",
      url: typeof window !== "undefined" ? window.location.origin : "http://localhost",
      icons: [],
    };
    modules.push(
      new WalletConnectModule({
        projectId: wc,
        metadata,
        allowedChains: [uiNetwork === "mainnet" ? WalletConnectTargetChain.PUBLIC : WalletConnectTargetChain.TESTNET],
      }),
    );
  }
  return modules;
}

/** Ensures the wallets kit is initialized for the given UI network (modules + passphrase context). */
export async function ensureWalletKit(uiNetwork: UiNetwork): Promise<void> {
  if (activeNetwork === uiNetwork) return;
  const modules = await buildModules(uiNetwork);
  StellarWalletsKit.init({
    modules,
    network: kitNetwork(uiNetwork),
  });
  activeNetwork = uiNetwork;
}

export async function connectWallet(uiNetwork: UiNetwork): Promise<{ address: string }> {
  await ensureWalletKit(uiNetwork);
  return StellarWalletsKit.authModal();
}

export async function disconnectWallet(uiNetwork: UiNetwork): Promise<void> {
  try {
    await ensureWalletKit(uiNetwork);
    await StellarWalletsKit.disconnect();
  } finally {
    activeNetwork = null;
  }
}

export async function openWalletProfile(uiNetwork: UiNetwork): Promise<void> {
  await ensureWalletKit(uiNetwork);
  await StellarWalletsKit.profileModal();
}

export async function signWithWallet(
  uiNetwork: UiNetwork,
  xdr: string,
  opts?: { networkPassphrase?: string; address?: string; path?: string; submit?: boolean; submitUrl?: string },
) {
  await ensureWalletKit(uiNetwork);
  return StellarWalletsKit.signTransaction(xdr, {
    networkPassphrase: opts?.networkPassphrase,
    address: opts?.address,
    path: opts?.path,
  });
}

/** Human-readable message for kit / modal errors (`{ code, message }` or `Error`). */
export function formatWalletError(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  if (e instanceof Error) return e.message;
  return "Wallet action failed.";
}
