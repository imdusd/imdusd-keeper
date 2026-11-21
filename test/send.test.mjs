// lib/rpc.mjs sendProvider: a signed transaction goes to VAULT_RPC_URL, then SEND_FALLBACK_RPC_URLS when the first
// fails as a provider; a refused transaction is not retried; "already known" is a success; keys never reach a log.
import test from "node:test";
import assert from "node:assert/strict";
import { utils, Wallet } from "ethers";
import { sendProvider, sendUrls } from "../lib/rpc.mjs";

const MEV = "https://rpc.mevblocker.io";
const BLOCKPI = "https://ethereum.blockpi.network/v1/rpc/blockpisecretkey0123456789";
const cfg = { VAULT_RPC_URL: MEV };
const env = { SEND_FALLBACK_RPC_URLS: ` ${BLOCKPI} ` };
const signed = await Wallet.createRandom().signTransaction({ chainId: 1, type: 2, nonce: 7, to: "0x0000000000000000000000000000000000000001", value: 0, gasLimit: 21000, maxFeePerGas: 2e9, maxPriorityFeePerGas: 1e8 });
const hash = utils.keccak256(signed);

/** `answers[url]` is a function returning a result or throwing; records who was asked. */
function rig(answers) {
  const asked = [];
  const logs = [];
  const make = (url) => ({
    sendTransaction: async (s) => {
      asked.push(url);
      return answers[url](s);
    },
    _wrapTransaction: (tx, h) => ({ hash: h, nonce: tx.nonce, wrapped: true }),
  });
  return { asked, logs, out: sendProvider(cfg, { env, make, log: (l) => logs.push(l) }) };
}
const ethersError = (message, url) => Object.assign(new Error(`${message} (url="${url}", code=SERVER_ERROR)`), { url, body: `{"error":"${message}"}` });

test("order: VAULT_RPC_URL, then the fallbacks; nothing configured -> first read RPC as before", () => {
  assert.deepEqual(sendUrls(cfg, env), [MEV, BLOCKPI]);
  assert.deepEqual(sendUrls({ ...cfg, SEND_FALLBACK_RPC_URLS: [BLOCKPI] }, {}), [MEV, BLOCKPI]);
  assert.deepEqual(sendUrls({ VAULT_RPC_URL: BLOCKPI }, env), [BLOCKPI]);
  assert.deepEqual(sendUrls({}, {}), ["https://ethereum-rpc.publicnode.com"]);
});

test("the primary answers: the fallback is never asked", async () => {
  const r = rig({ [MEV]: () => ({ hash }), [BLOCKPI]: () => assert.fail("asked") });
  assert.equal((await r.out.sendTransaction(signed)).hash, hash);
  assert.deepEqual(r.asked, [MEV]);
});

test("a rate limit, 5xx or timeout moves to the fallback; the log names hosts, never the key", async () => {
  for (const msg of ["error code: 1015", "bad response 504", "timeout", "missing response"]) {
    const r = rig({ [MEV]: () => { throw ethersError(msg, MEV); }, [BLOCKPI]: () => ({ hash }) });
    assert.equal((await r.out.sendTransaction(signed)).hash, hash, msg);
    assert.deepEqual(r.asked, [MEV, BLOCKPI]);
    assert.match(r.logs[0], /rpc\.mevblocker\.io failed .* sent via ethereum\.blockpi\.network/);
    assert.ok(!r.logs.join(" ").includes("blockpisecretkey"));
  }
});

test("a refused transaction is thrown at once, not retried elsewhere", async () => {
  for (const msg of ["nonce too low", "insufficient funds for gas * price + value", "replacement transaction underpriced"]) {
    const r = rig({ [MEV]: () => { throw ethersError(msg, MEV); }, [BLOCKPI]: () => assert.fail("asked") });
    await assert.rejects(r.out.sendTransaction(signed), new RegExp(msg.slice(0, 10)));
    assert.deepEqual(r.asked, [MEV]);
  }
});

test("'already known' (e.g. the copy a timed-out primary took) is a success with the signed hash", async () => {
  const r = rig({ [MEV]: () => { throw ethersError("timeout", MEV); }, [BLOCKPI]: () => { throw ethersError("already known", BLOCKPI); } });
  const res = await r.out.sendTransaction(signed);
  assert.equal(res.hash, hash);
  assert.equal(res.nonce, 7);
});

test("both fail: the last error is thrown with the key scrubbed", async () => {
  const r = rig({ [MEV]: () => { throw ethersError("error code: 1015", MEV); }, [BLOCKPI]: () => { throw ethersError("bad response 502", BLOCKPI); } });
  await assert.rejects(r.out.sendTransaction(signed), (e) => {
    for (const s of [e.message, e.url, e.body]) assert.ok(!String(s).includes("blockpisecretkey"), s);
    assert.match(e.message, /ethereum\.blockpi\.network/);
    return true;
  });
});
