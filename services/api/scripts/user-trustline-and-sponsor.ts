/**
 * From one funded testnet account (env STELLAR_SECRET):
 * - Add two trustlines to new demo assets (new issuers, Friendbot-funded).
 * - Sponsor-create a new child account (Begin → CreateAccount → End).
 *
 * Usage:
 *   STELLAR_SECRET=S... npx tsx services/api/scripts/user-trustline-and-sponsor.ts
 */
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIEND = "https://friendbot.stellar.org";

async function friendbot(addr: string): Promise<void> {
  const res = await fetch(`${FRIEND}/?addr=${encodeURIComponent(addr)}`);
  if (!res.ok) {
    throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
  }
}

async function main(): Promise<void> {
  const secret = process.env.STELLAR_SECRET?.trim();
  if (!secret) {
    console.error("Set STELLAR_SECRET to your testnet account secret.");
    process.exit(1);
  }

  const user = Keypair.fromSecret(secret);
  const issuer1 = Keypair.random();
  const issuer2 = Keypair.random();
  const sponsoredChild = Keypair.random();

  const server = new Horizon.Server(HORIZON);

  console.log("User (trustlines + sponsor):", user.publicKey());
  console.log("Issuer1:", issuer1.publicKey(), issuer1.secret());
  console.log("Issuer2:", issuer2.publicKey(), issuer2.secret());
  console.log("New sponsored child:", sponsoredChild.publicKey());

  await friendbot(issuer1.publicKey());
  await friendbot(issuer2.publicKey());

  const code1 = `UT1${Math.floor(Math.random() * 900 + 100)}`;
  const code2 = `UT2${Math.floor(Math.random() * 900 + 100)}`;
  const asset1 = new Asset(code1, issuer1.publicKey());
  const asset2 = new Asset(code2, issuer2.publicKey());

  const fee = await server.fetchBaseFee();
  const baseOpts = { fee, networkPassphrase: Networks.TESTNET } as const;

  // Trustlines from user account
  const u0 = await server.loadAccount(user.publicKey());
  const trustTx = new TransactionBuilder(u0, { ...baseOpts })
    .addOperation(Operation.changeTrust({ asset: asset1, limit: "1000000" }))
    .addOperation(Operation.changeTrust({ asset: asset2, limit: "1000000" }))
    .setTimeout(180)
    .build();
  trustTx.sign(user);
  await server.submitTransaction(trustTx);
  console.log(`Trustlines added: ${code1}, ${code2}`);

  // Mint small amounts to user
  const i1 = await server.loadAccount(issuer1.publicKey());
  const pay1 = new TransactionBuilder(i1, { ...baseOpts })
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset: asset1,
        amount: "500",
      }),
    )
    .setTimeout(180)
    .build();
  pay1.sign(issuer1);
  await server.submitTransaction(pay1);

  const i2 = await server.loadAccount(issuer2.publicKey());
  const pay2 = new TransactionBuilder(i2, { ...baseOpts })
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset: asset2,
        amount: "250",
      }),
    )
    .setTimeout(180)
    .build();
  pay2.sign(issuer2);
  await server.submitTransaction(pay2);
  console.log("Issuers paid user 500 + 250 units.");

  // Sponsored child account (user is sponsor)
  const u1 = await server.loadAccount(user.publicKey());
  const sponsorTx = new TransactionBuilder(u1, { ...baseOpts })
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
        source: sponsoredChild.publicKey(),
      }),
    )
    .setTimeout(180)
    .build();
  sponsorTx.sign(user);
  sponsorTx.sign(sponsoredChild);
  await server.submitTransaction(sponsorTx);

  console.log("\n--- Save if you need the child account ---");
  console.log("sponsoredChild public:", sponsoredChild.publicKey());
  console.log("sponsoredChild secret:", sponsoredChild.secret());
  console.log("\nHorizon (user):", `${HORIZON}/accounts/${user.publicKey()}`);
}

main().catch((e) => {
  console.error(e?.response?.data?.extras ?? e?.message ?? e);
  process.exit(1);
});
