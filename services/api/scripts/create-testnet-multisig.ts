/**
 * Create a testnet account shape that Orbitway flags for extra signers, while
 * still letting the master key remove the extra signer later.
 *
 * Usage:
 *   STELLAR_SECRET=S... npx tsx services/api/scripts/create-testnet-multisig.ts
 *
 * Optional:
 *   EXTRA_SIGNER_SECRET=S...  Reuse an existing signer key instead of generating one
 *
 * Behavior:
 * - Verifies `STELLAR_SECRET` matches the expected source account for this task.
 * - Friendbot-funds the source account if it does not exist on testnet yet.
 * - Adds one extra `ed25519_public_key` signer with weight 1.
 * - Sets master weight 1 and thresholds to 1/1/1 so the master key alone can
 *   later submit `SetOptions` to remove that extra signer.
 */
import {
  Horizon,
  Keypair,
  Networks,
  NotFoundError,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIEND = "https://friendbot.stellar.org";
const EXPECTED_SOURCE = "GA4DXGJXS4446QUW4JYOISP37DFWS5GLB3SFBTOGBPRS3X2C3WICH2OT";

async function friendbot(addr: string): Promise<void> {
  const res = await fetch(`${FRIEND}/?addr=${encodeURIComponent(addr)}`);
  if (!res.ok) {
    throw new Error(`Friendbot ${res.status}: ${await res.text()}`);
  }
}

async function ensureSourceExists(server: Horizon.Server, address: string): Promise<void> {
  try {
    await server.loadAccount(address);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    console.log("Source account not found on testnet. Funding with Friendbot...");
    await friendbot(address);
    await server.loadAccount(address);
  }
}

async function main(): Promise<void> {
  const secret = 'SCPKJ3VNUWIKSWAIMBJ7NOVTIIUPZF6YGY77BBV4NABKIJOKP6RKYAMD';
  if (!secret) {
    console.error("Set STELLAR_SECRET to the source account secret.");
    process.exit(1);
  }

  const source = Keypair.fromSecret(secret);
  if (source.publicKey() !== EXPECTED_SOURCE) {
    console.error(`STELLAR_SECRET does not match expected source ${EXPECTED_SOURCE}.`);
    process.exit(1);
  }

  const extraSignerSecret = process.env.EXTRA_SIGNER_SECRET?.trim();
  const extraSigner = extraSignerSecret ? Keypair.fromSecret(extraSignerSecret) : Keypair.random();
  const server = new Horizon.Server(HORIZON);

  await ensureSourceExists(server, source.publicKey());

  const account = await server.loadAccount(source.publicKey());
  const fee = await server.fetchBaseFee();
  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.setOptions({
        signer: {
          ed25519PublicKey: extraSigner.publicKey(),
          weight: 1,
        },
        masterWeight: 1,
        lowThreshold: 1,
        medThreshold: 1,
        highThreshold: 1,
      }),
    )
    .setTimeout(180)
    .build();

  tx.sign(source);
  await server.submitTransaction(tx);

  console.log("Created testnet account shape with one extra signer.");
  console.log("source public:", source.publicKey());
  console.log("extra signer public:", extraSigner.publicKey());
  if (!extraSignerSecret) {
    console.log("extra signer secret:", extraSigner.secret());
  }
  console.log("thresholds: low=1 med=1 high=1");
  console.log("master weight: 1");
  console.log("extra signer weight: 1");
  console.log("Horizon:", `${HORIZON}/accounts/${source.publicKey()}`);
}

main().catch((e) => {
  console.error(e?.response?.data?.extras ?? e?.message ?? e);
  process.exit(1);
});
