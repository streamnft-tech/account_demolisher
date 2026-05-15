/**
 * For an existing funded account (env STELLAR_SECRET):
 * - Add trustline on the user account for a new demo asset (Friendbot-funded issuer).
 * - Mint to user.
 * - Sponsor-create a new child account.
 */
import {
  Asset,
  BASE_FEE,
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
  if (!res.ok) throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
}

async function main(): Promise<void> {
  const secret = process.env.STELLAR_SECRET?.trim();
  if (!secret) {
    console.error("Set STELLAR_SECRET to your testnet account secret.");
    process.exit(1);
  }

  const user = Keypair.fromSecret(secret);
  const issuer = Keypair.random();
  const sponsoredChild = Keypair.random();

  const server = new Horizon.Server(HORIZON);
  const base = { fee: BASE_FEE, networkPassphrase: Networks.TESTNET } as const;

  console.log("User (trustline + sponsor):", user.publicKey());
  console.log("Issuer:", issuer.publicKey(), issuer.secret());
  console.log("Sponsored child:", sponsoredChild.publicKey(), sponsoredChild.secret());

  await friendbot(issuer.publicKey());

  const code = `AS${Math.floor(Math.random() * 900 + 100)}`;
  const asset = new Asset(code, issuer.publicKey());

  const u0 = await server.loadAccount(user.publicKey());
  const trustTx = new TransactionBuilder(u0, base)
    .addOperation(Operation.changeTrust({ asset, limit: "10000000" }))
    .setTimeout(180)
    .build();
  trustTx.sign(user);
  await server.submitTransaction(trustTx);
  console.log(`Trustline added on user for ${code}.`);

  const i0 = await server.loadAccount(issuer.publicKey());
  const payTx = new TransactionBuilder(i0, base)
    .addOperation(
      Operation.payment({
        destination: user.publicKey(),
        asset,
        amount: "1000",
      }),
    )
    .setTimeout(180)
    .build();
  payTx.sign(issuer);
  await server.submitTransaction(payTx);
  console.log("Issuer paid user 1000 units.");

  const u1 = await server.loadAccount(user.publicKey());
  const sponsorTx = new TransactionBuilder(u1, base)
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
  console.log("Sponsored child account created.");

  console.log("\nHorizon (user):", `${HORIZON}/accounts/${user.publicKey()}`);
}

main().catch((e) => {
  console.error(e?.response?.data?.extras ?? e?.message ?? e);
  process.exit(1);
});
