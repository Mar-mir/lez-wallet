// Dual-licensed: MIT OR Apache-2.0
/**
 * LEZ wallet — end-to-end demo of @lez/core against the in-memory mock chain.
 * No external services or binaries needed. Safe to run repeatedly: all state
 * lives in memory and is discarded when the process exits.
 *
 * Usage:  node scripts/demo.mjs
 */
import {
  MockBackend,
  MemoryStateStorage,
  MemoryVaultStorage,
  StateManager,
  PasswordVault,
  WalletSDK,
  NATIVE_ASSET_ID,
  formatAmount,
} from "../packages/core/dist/index.js";

const ORIGIN = "https://demo.lez.example";
const step = (n, msg) => console.log("\n" + n + ". " + msg);
const ok = (msg) => console.log("   " + msg);

async function main() {
  console.log("=== LEZ wallet demo (@lez/core + MockBackend) ===");

  // 1. wire the SDK: mock chain + in-memory state + password vault
  step(1, "wire WalletSDK (mock chain, memory state, memory vault)");
  const backend = new MockBackend();
  const state = new StateManager(new MemoryStateStorage());
  const vault = new PasswordVault(new MemoryVaultStorage());
  await vault.setPassword("correct horse battery staple", undefined);
  const sdk = new WalletSDK({
    backend,
    state,
    vault,
    prompt: async (req) => {
      console.log("   [approval prompt] " + req.origin + " account=" + req.accountId +
        " caps=[" + req.capabilities.join(", ") + "]" + (req.note ? " note=" + req.note : ""));
      return true; // auto-approve in the demo; a real UI would ask here
    },
  });
  ok("vault initialized, wallet unlocked");

  // 2. accounts
  step(2, "create accounts");
  const main1 = await sdk.createAccount("public", { label: "Main" });
  const priv = await sdk.createAccount("private", { label: "Private", seedHex: "11".repeat(64) });
  ok("public  : " + main1.label + " " + main1.address);
  ok("private : " + priv.label + " " + priv.address + " (npk " + String(priv.npk).slice(0, 16) + "...)");

  // 3. fund them from the faucet
  step(3, "faucet: 15 LOG -> Main, 3 LOG -> Private (base units, 9 decimals)");
  await backend.faucet(main1.address, NATIVE_ASSET_ID, "15000000000");
  await backend.faucet(priv.address, NATIVE_ASSET_ID, "3000000000");

  // 4. dApp connect (LP-0021)
  step(4, "dApp connect: " + ORIGIN);
  const summary = await sdk.connect({ origin: ORIGIN });
  ok("connected to " + summary.label + " (" + summary.address.slice(0, 12) + "...)");
  ok("granted capabilities: " + JSON.stringify((await sdk.getPermissions(ORIGIN)).permissions));

  // 5. balances
  step(5, "read balances");
  const bal = await sdk.getBalance(ORIGIN, main1.id, NATIVE_ASSET_ID);
  ok("Main    : " + formatAmount(bal.amount, bal.decimals) + " " + bal.assetSymbol);
  const bal2 = await sdk.getBalance(ORIGIN, priv.id, NATIVE_ASSET_ID).catch((e) => e);
  if (bal2 instanceof Error) {
    ok("Private : not readable via dApp grant (grant is scoped to one account): " + bal2.code);
  }

  // 6. transfer (every submission is confirmed explicitly -> prompt above)
  step(6, "send 2.5 LOG from Main to Private");
  const tx = await sdk.send(ORIGIN, {
    fromAccountId: main1.id,
    to: { address: priv.address, type: "private" },
    amount: "2500000000",
  });
  ok("tx submitted: " + tx.hash.slice(0, 16) + "... status=" + tx.status);

  // 7. confirmation
  step(7, "wait for confirmation (mock chain confirms on the 2nd poll)");
  const confirmed = await sdk.tx.awaitConfirmation(tx.hash, { polls: 3, intervalMs: 150 });
  ok("status=" + confirmed.status + " gasUsed=" + confirmed.gasUsed);

  // 8. history
  step(8, "tx history for the connected account");
  for (const r of await sdk.getHistory(ORIGIN)) {
    ok(r.direction + " " + r.status + " " + formatAmount(r.amount, 9) + " " + r.assetSymbol +
      "  " + r.hash.slice(0, 16) + "...");
  }

  // 9. contract call: publishTestimonial (the grant is still scoped to Main)
  step(9, "executeProgram: testimonial#publishTestimonial");
  const call = await sdk.executeProgram(ORIGIN, {
    fromAccountId: main1.id,
    programId: "testimonial",
    instruction: "publishTestimonial",
    args: ["hello lez", "demo", "sub-1", 0],
  });
  ok("tx " + call.hash.slice(0, 16) + "... program=" + call.programId + "#" + call.instruction);
  const st = await sdk.getState(ORIGIN, main1.id, "testimonial");
  ok("on-chain state: " + JSON.stringify(st.data));

  // 10. key export (LP-0021: prompted every time; read_keys is never default).
  // NOTE: a grant is scoped to exactly one account (last grant wins) — after
  // exporting keys for Private the origin is now scoped to Private only.
  step(10, "revealKeys on the private account (explicit read_keys prompt)");
  const keys = await sdk.revealKeys(ORIGIN, priv.id);
  ok("npk = " + keys.npk);
  ok("vpk = " + keys.vpk);
  ok("secretKey = " + keys.secretKey.slice(0, 8) + "... (masked)");
  ok("grant now points to Private: " + JSON.stringify(await sdk.getPermissions(ORIGIN)));

  // 11. error contract: user rejects the next prompt
  step(11, "error contract: user vetoes the next transaction");
  sdk.approvals.setPrompt(async () => false);
  try {
    await sdk.send(ORIGIN, {
      fromAccountId: main1.id,
      to: { address: priv.address, type: "private" },
      amount: "1",
    });
    ok("UNEXPECTED: vetoed send went through");
  } catch (e) {
    ok("send rejected as expected: code=" + e.code);
  }

  // 12. error contract: disconnected origin
  step(12, "disconnect and check unauthorized");
  await sdk.disconnect(ORIGIN);
  ok("granted accounts now: " + JSON.stringify(await sdk.getAccounts(ORIGIN)));
  try {
    await sdk.getBalance(ORIGIN, main1.id, NATIVE_ASSET_ID);
    ok("UNEXPECTED: read after disconnect went through");
  } catch (e) {
    ok("read rejected as expected: code=" + e.code);
  }

  console.log("\n=== demo completed successfully ===");
}

main().catch((e) => {
  console.error("demo failed:", e);
  process.exit(1);
});
