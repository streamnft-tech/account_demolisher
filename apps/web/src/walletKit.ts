import { StellarWalletsKit } from "@creit.tech/stellar-wallets-kit/sdk";
import { AlbedoModule } from "@creit.tech/stellar-wallets-kit/modules/albedo";
import { FreighterModule } from "@creit.tech/stellar-wallets-kit/modules/freighter";
import { LobstrModule } from "@creit.tech/stellar-wallets-kit/modules/lobstr";
import { xBullModule } from "@creit.tech/stellar-wallets-kit/modules/xbull";
import { Networks } from "@creit.tech/stellar-wallets-kit/types";

import type { UiNetwork } from "./network.js";

let initialized = false;

function kitNetwork(ui: UiNetwork): Networks {
  return ui === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/**
 * Configure Stellar Wallets Kit (Freighter, Albedo, xBull, LOBSTR, optional WalletConnect for mobile wallets).
 * WalletConnect is loaded only when `VITE_WALLETCONNECT_PROJECT_ID` is set (smaller default bundle).
 */
export async function ensureWalletKit(uiNetwork: UiNetwork): Promise<void> {
  const n = kitNetwork(uiNetwork);
  if (initialized) {
    StellarWalletsKit.setNetwork(n);
    return;
  }
  const modules = [new FreighterModule(), new AlbedoModule(), new xBullModule(), new LobstrModule()];
  const wc = import.meta.env.VITE_WALLETCONNECT_PROJECT_ID?.trim();
  if (wc) {
    const { WalletConnectModule } = await import("@creit.tech/stellar-wallets-kit/modules/wallet-connect");
    modules.push(
      new WalletConnectModule({
        projectId: wc,
        metadata: {
          name: "Account Demolisher",
          description: "Sign classic Stellar transactions to close offers and LP before account merge.",
          url: typeof window !== "undefined" ? window.location.origin : "http://localhost",
          icons: [],
        },
      }),
    );
  }
  StellarWalletsKit.init({
    network: n,
    modules,
  });
  initialized = true;
}
