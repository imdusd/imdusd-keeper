// Reads and sends go to different places (mainnet review 2026-10-11). VAULT_RPC_URL is meant for a private mempool (MEV Blocker,
// Flashbots Protect): right for SUBMITTING a signed transaction (private, no front-running), wrong for the keeper's hundreds of reads
// a minute, which it answered with 504s often enough to fail runs. Reads use READ_RPC_URLS (publicnode, then drpc,
// failing over); only a signed transaction goes to VAULT_RPC_URL.
import { providers, utils } from "ethers";

const READS = ["https://ethereum-rpc.publicnode.com", "https://eth.drpc.org"];

/** Every read: the first of READ_RPC_URLS that answers, the next after a two-second stall or an error. */
export function readProvider(cfg) {
  const urls = (process.env.READ_RPC_URLS?.split(",") ?? cfg.READ_RPC_URLS ?? READS).map((u) => u.trim()).filter(Boolean);
  if (urls.length === 1) return new providers.StaticJsonRpcProvider(urls[0], 1);
  return new providers.FallbackProvider(
    urls.map((u, i) => ({ provider: new providers.StaticJsonRpcProvider(u, 1), priority: i + 1, stallTimeout: 2000, weight: 1 })),
    1,
  );
}

/** Where signed transactions are submitted: VAULT_RPC_URL (a private mempool, ideally), else the first read RPC, then
 *  each of SEND_FALLBACK_URLS in turn (2026-11-21: Blink, after MEV Blocker rate-limited sends on launch day). A route
 *  gets 15 s; ethers' default of two minutes would hold a bite that long on a stalled route. */
export function sendRoutes(cfg) {
  const more = (process.env.SEND_FALLBACK_URLS?.split(",") ?? cfg.SEND_FALLBACK_URLS ?? []).map((u) => u.trim()).filter(Boolean);
  return [cfg.VAULT_RPC_URL || (cfg.READ_RPC_URLS ?? READS)[0], ...more].map((url) => ({
    name: new URL(url).host, // never the whole URL: a route's API key is often its path (Blink: /v1/<key>)
    provider: new providers.StaticJsonRpcProvider({ url, timeout: 15_000 }, 1),
  }));
}

/** Submits one signed transaction: the first route that accepts it wins, the next is tried after a refusal or a stall.
 *  Resending the same signed bytes is safe: same nonce, same hash, so it can land once at most. Only the raw
 *  eth_sendRawTransaction goes out; ethers' own sendTransaction first asks for the chain id and block number, three
 *  calls that a tightly rate-limited route (Blink allows about one every 2 s) answers with a 429 on the send itself.
 *  Throws when every route refuses, naming each route's answer. */
export async function broadcast(routes, signed) {
  const hash = utils.keccak256(signed);
  const why = [];
  for (const r of routes) {
    try {
      const got = await r.provider.send("eth_sendRawTransaction", [signed]);
      if (got && got.toLowerCase() !== hash) console.log(`send    ${r.name} answered ${got} for ${hash}`);
      if (why.length) console.log(`send    ${hash} via ${r.name}, after ${why.join("; ")}`);
      return { hash, route: r.name };
    } catch (e) {
      const msg = e.error?.message ?? e.reason ?? e.message ?? String(e);
      // An earlier route that stalled may have taken it after all: a route that already holds these bytes has them.
      if (why.length && /already known|known transaction|already imported/i.test(msg)) return { hash, route: r.name };
      why.push(`${r.name}: ${msg.slice(0, 100)}`);
    }
  }
  throw new Error(`every send route refused: ${why.join("; ")}`);
}
