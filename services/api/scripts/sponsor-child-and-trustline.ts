/**
 * For an existing funded account (env STELLAR_SECRET = GA4… secret):
 * 1. Create a new child account (sponsored create + end in one tx).
 * 2. Add a trustline on the child for a new Friendbot-funded issuer asset; trustline reserve is sponsored (begin → changeTrust w/ child source → end).
 * 3. Issuer pays the child a starter balance of the asset.
 *
 * Usage:
 *   STELLAR_SECRET=S... npx tsx services/api/scripts/sponsor-child-and-trustline.ts
 */
import {
  Asset,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  BASE_FEE,
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
    console.error("Set STELLAR_SECRET to the sponsor account secret (testnet).");
    process.exit(1);
  }

  const sponsor = Keypair.fromSecret(secret);
  const child = Keypair.random();
  const issuer = Keypair.random();

  const server = new Horizon.Server(HORIZON);
  const net = Networks.TESTNET;
  const base = { fee: BASE_FEE, networkPassphrase: net } as const;

  console.log("Sponsor:", sponsor.publicKey());
  console.log("New child:", child.publicKey(), child.secret());
  console.log("Issuer:", issuer.publicKey(), issuer.secret());

  await friendbot(issuer.publicKey());

  const code = `SL${Math.floor(Math.random() * 900 + 100)}`;
  const asset = new Asset(code, issuer.publicKey());

  // 1) Sponsored account create (sponsor pays; child signs end)
  const s0 = await server.loadAccount(sponsor.publicKey());
  const txCreate = new TransactionBuilder(s0, base)
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: child.publicKey(),
      }),
    )
    .addOperation(
      Operation.createAccount({
        destination: child.publicKey(),
        startingBalance: "3",
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: child.publicKey(),
      }),
    )
    .setTimeout(180)
    .build();
  txCreate.sign(sponsor);
  txCreate.sign(child);
  await server.submitTransaction(txCreate);
  console.log("Submitted: sponsored child create (3 XLM).");

  // 2) Sponsored trustline on child (changeTrust source = child)
  const s1 = await server.loadAccount(sponsor.publicKey());
  const txTrust = new TransactionBuilder(s1, base)
    .addOperation(
      Operation.beginSponsoringFutureReserves({
        sponsoredId: child.publicKey(),
      }),
    )
    .addOperation(
      Operation.changeTrust({
        asset,
        limit: "10000000",
        source: child.publicKey(),
      }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({
        source: child.publicKey(),
      }),
    )
    .setTimeout(180)
    .build();
  txTrust.sign(sponsor);
  txTrust.sign(child);
  await server.submitTransaction(txTrust);
  console.log(`Submitted: sponsored trustline for ${code}.`);

  const iAcc = await server.loadAccount(issuer.publicKey());
  const payTx = new TransactionBuilder(iAcc, base)
    .addOperation(
      Operation.payment({
        destination: child.publicKey(),
        asset,
        amount: "1000",
      }),
    )
    .setTimeout(180)
    .build();
  payTx.sign(issuer);
  await server.submitTransaction(payTx);
  console.log("Submitted: issuer paid child 1000 units.");

  console.log("\nHorizon child:", `${HORIZON}/accounts/${child.publicKey()}`);
}

main().catch((e) => {
  console.error(e?.response?.data?.extras ?? e?.message ?? e);
  process.exit(1);
});
