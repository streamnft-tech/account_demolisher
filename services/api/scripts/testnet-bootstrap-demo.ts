/**
 * Demo: testnet keypairs → Friendbot → custom asset trustline + mint → optional sponsored child account.
 *
 * Usage (from repo root):
 *   npx tsx services/api/scripts/testnet-bootstrap-demo.ts
 *
 * Saves nothing to disk; prints secrets — use only on testnet.
 */
import {
  Asset,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  Horizon,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIEND = "https://friendbot.stellar.org";

async function friendbot(addr: string): Promise<void> {
  const res = await fetch(`${FRIEND}/?addr=${encodeURIComponent(addr)}`);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Friendbot ${res.status} for ${addr}: ${t}`);
  }
}

async function main(): Promise<void> {
  const server = new Horizon.Server(HORIZON);
  const issuer = Keypair.random();
  const holder = Keypair.random();
  const sponsor = Keypair.random();
  const sponsoredChild = Keypair.random();

  console.log("--- Keypairs (save these if you want to reuse) ---");
  console.log("issuer", issuer.publicKey(), issuer.secret());
  console.log("holder", holder.publicKey(), holder.secret());
  console.log("sponsor", sponsor.publicKey(), sponsor.secret());
  console.log("sponsoredChild", sponsoredChild.publicKey(), sponsoredChild.secret());

  console.log("\n--- Funding via Friendbot ---");
  await Promise.all([
    friendbot(issuer.publicKey()),
    friendbot(holder.publicKey()),
    friendbot(sponsor.publicKey()),
  ]);
  console.log("Funded issuer, holder, sponsor.");

  const assetCode = `DEMO${Math.floor(Math.random() * 900 + 100)}`;
  const custom = new Asset(assetCode, issuer.publicKey());

  console.log(`\n--- Trustline + mint (${assetCode}) ---`);
  const holderAccount = await server.loadAccount(holder.publicKey());
  const trustTx = new TransactionBuilder(holderAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.changeTrust({
        asset: custom,
        limit: "10000000",
      }),
    )
    .setTimeout(180)
    .build();
  trustTx.sign(holder);
  await server.submitTransaction(trustTx);
  console.log("ChangeTrust submitted.");

  const issuerAccount = await server.loadAccount(issuer.publicKey());
  const payTx = new TransactionBuilder(issuerAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: holder.publicKey(),
        asset: custom,
        amount: "1000",
      }),
    )
    .setTimeout(180)
    .build();
  payTx.sign(issuer);
  await server.submitTransaction(payTx);
  console.log("Mint (issuer → holder payment) submitted.");

  console.log("\n--- Sponsored new account (sponsor pays create + reserves) ---");
  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const sponsorTx = new TransactionBuilder(sponsorAccount, {
    fee: await server.fetchBaseFee(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: sponsoredChild.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: sponsoredChild.publicKey(),
        startingBalance: "1",
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: sponsoredChild.publicKey(), // op source = sponsored; requires child signature
      }),
    )
    .setTimeout(180)
    .build();
  sponsorTx.sign(sponsor);
  sponsorTx.sign(sponsoredChild);
  await server.submitTransaction(sponsorTx);
  console.log("Sponsored child account created on-ledger.");

  const child = await server.loadAccount(sponsoredChild.publicKey());
  console.log(`Child balances: ${JSON.stringify(child.balances.map((b) => ({ type: b.asset_type, balance: b.balance })))}`);
  console.log("\nDone. Horizon:", `${HORIZON}/accounts/${holder.publicKey()}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
