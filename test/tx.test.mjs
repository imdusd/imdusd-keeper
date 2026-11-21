// send(): whatever happens after the simulation, it answers rather than throws, and a broadcast keeps its hash.
import test from "node:test";
import assert from "node:assert/strict";
import { utils } from "ethers";
import { describe, send } from "../lib/tx.mjs";
import { discoverOwners } from "../lib/vault.mjs";
import { broadcast, sendRoutes } from "../lib/rpc.mjs";

const signer = { provider: { getGasPrice: async () => utils.parseUnits("1", "gwei"), getBalance: async () => utils.parseEther("1") } };
const go = (sendIt) => send(signer, "bite", async () => {}, sendIt, { MAX_GAS_GWEI: 50, MIN_ETH: 0.003 });
const tx = (wait) => async () => ({ hash: "0xabc", wait });

test("mined: the receipt's figures", async () => {
  const r = await go(tx(async () => ({ blockNumber: 5, gasUsed: { toString: () => "21000" } })));
  assert.deepEqual(r, { hash: "0xabc", block: 5, gas: "21000" });
});

test("no receipt: it may still land, so the hash stays and spend ledgers count it", async () => {
  const r = await go(tx(async () => { throw new Error("no receipt within 5 minutes"); }));
  assert.equal(r.hash, "0xabc");
  assert.match(describe(r), /not confirmed/);
});

test("reverted: no hash, so nothing counts it as sent", async () => {
  const r = await go(tx(async () => { throw Object.assign(new Error("reverted"), { reverted: true }); }));
  assert.equal(r.hash, undefined);
  assert.match(describe(r), /reverted 0xabc/);
});

test("the send itself fails: answered, so the next position still gets its turn", async () => {
  const r = await go(async () => { throw new Error("every send RPC refused"); });
  assert.equal(r.hash, undefined);
  assert.match(describe(r), /failed/);
});

test("owner discovery refuses to return a truncated list", async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ items: [{}], next_page_params: { block_number: 1 } }) });
  await assert.rejects(discoverOwners("https://x.example", "0x01", { fetchImpl, maxPages: 3 }), /past 3 pages/);
});

// broadcast(): the same signed bytes, route after route, until one takes them.
const signed = "0x02f8" + "ab".repeat(40);
const route = (name, answer) => ({ name, provider: { send: async () => answer() } });
const refuse = (msg) => () => { throw Object.assign(new Error("bad response"), { error: { message: msg } }); };

test("broadcast: the first route that takes it wins, and the hash is the bytes' own", async () => {
  const r = await broadcast([route("a", refuse("rate limited")), route("b", async () => utils.keccak256(signed))], signed);
  assert.deepEqual(r, { hash: utils.keccak256(signed), route: "b" });
});

test("broadcast: a later route that already holds the bytes counts as sent", async () => {
  const r = await broadcast([route("a", refuse("timeout")), route("b", refuse("already known"))], signed);
  assert.equal(r.route, "b");
});

test("broadcast: every route refusing throws, naming each answer", async () => {
  await assert.rejects(broadcast([route("a", refuse("429")), route("b", refuse("nonce too low"))], signed), /a: 429; b: nonce too low/);
});

test("send routes: VAULT_RPC_URL first, then SEND_FALLBACK_URLS; names are hosts, never a key in the path", () => {
  process.env.SEND_FALLBACK_URLS = " https://eth.blinklabs.xyz/v1/secretkey , ";
  try {
    assert.deepEqual(sendRoutes({ VAULT_RPC_URL: "https://rpc.mevblocker.io" }).map((r) => r.name), ["rpc.mevblocker.io", "eth.blinklabs.xyz"]);
  } finally {
    delete process.env.SEND_FALLBACK_URLS;
  }
});
