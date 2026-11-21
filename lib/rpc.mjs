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

/** The private send RPCs, in order: VAULT_RPC_URL (MEV Blocker, say), then SEND_FALLBACK_RPC_URLS (comma-separated,
 * e.g. Blink). Without either, the first read RPC (public mempool), as before. */
export function sendUrls(cfg, env = process.env) {
  const fallbacks = (env.SEND_FALLBACK_RPC_URLS?.split(",") ?? cfg.SEND_FALLBACK_RPC_URLS ?? []).map((u) => u.trim()).filter(Boolean);
  const urls = [...new Set([cfg.VAULT_RPC_URL, ...fallbacks].filter(Boolean))];
  return urls.length ? urls : [(cfg.READ_RPC_URLS ?? READS)[0]];
}

// A SIGNED transaction can be handed to a second RPC safely: it is the same transaction (same hash, same nonce), so at
// most one copy is mined. So the next RPC is asked whenever this one fails as a PROVIDER (rate limit, e.g. MEV Blocker's
// 1015 on launch day 2026-10-11; 5xx; timeout; network), but not when the transaction itself is refused: a nonce
// already used, too little ETH or an underpriced replacement is the same answer everywhere. "Already known" means a
// copy is in that mempool (often the one an RPC took before it timed out): that is a success.
const REFUSED = /nonce too low|nonce has already been used|insufficient funds|underpriced|intrinsic gas|exceeds block gas limit|invalid sender|max fee per gas less than/i;
const KNOWN = /already known|known transaction|alreadyknown|already imported|already in (the )?(mempool|pool)/i;
const text = (e) => [e?.message, e?.error?.message, e?.body, e?.reason].filter(Boolean).join(" ");
/** A URL as logs show it: the host only (a keyed URL's path holds the key). */
export const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "?";
  }
};

/** Where signed transactions go: sendTransaction(signed) tries each send RPC in turn (see above). */
export function sendProvider(cfg, { env = process.env, make = (url) => new providers.StaticJsonRpcProvider({ url, timeout: 20_000 }, 1), log = console.log } = {}) {
  const outs = sendUrls(cfg, env).map((url) => ({ url, p: make(url) }));
  // ethers puts the URL in its error messages: keep keys out of the keeper's log and of anything it throws.
  const scrub = (e) => {
    for (const k of ["message", "reason", "body", "url"]) {
      if (typeof e?.[k] !== "string") continue;
      for (const { url } of outs) e[k] = e[k].split(url).join(hostOf(url));
    }
    if (e?.error) scrub(e.error);
    return e;
  };
  return {
    urls: outs.map((o) => o.url),
    async sendTransaction(signed) {
      const hash = utils.keccak256(signed);
      let last;
      for (const [i, { url, p }] of outs.entries()) {
        try {
          const res = await p.sendTransaction(signed);
          if (i > 0) log(`send: ${hostOf(outs[0].url)} failed (${text(last).slice(0, 100)}); sent via ${hostOf(url)}`);
          return res;
        } catch (err) {
          const e = scrub(err);
          if (KNOWN.test(text(e))) return outs[0].p._wrapTransaction(utils.parseTransaction(signed), hash);
          if (REFUSED.test(text(e))) throw e;
          last = e;
        }
      }
      throw last;
    },
  };
}
