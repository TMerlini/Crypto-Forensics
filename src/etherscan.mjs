// Etherscan V2 multichain API client.
// Docs: https://docs.etherscan.io/etherscan-v2
// Handles: rate limiting, paginated fetches, exponential backoff on transient errors.

const BASE = "https://api.etherscan.io/v2/api";

// Etherscan lists are capped at 10k rows per query. We page using startblock
// cursors: ask for the first 10k sorted ascending, then fetch the next 10k
// starting from (last returned blockNumber + 1), and so on.
const PAGE_LIMIT = 10_000;

export class RateLimiter {
  constructor(rps) {
    this.intervalMs = 1000 / rps;
    this.nextAllowedAt = 0;
  }
  async acquire() {
    const now = Date.now();
    const wait = Math.max(0, this.nextAllowedAt - now);
    this.nextAllowedAt = Math.max(now, this.nextAllowedAt) + this.intervalMs;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
}

export class Etherscan {
  constructor({ apiKey, chainId, rps = 4 }) {
    if (!apiKey) throw new Error("ETHERSCAN_API_KEY is required");
    this.apiKey = apiKey;
    this.chainId = String(chainId);
    this.limiter = new RateLimiter(rps);
  }

  async _call(params, { retries = 5 } = {}) {
    const url = new URL(BASE);
    url.searchParams.set("chainid", this.chainId);
    url.searchParams.set("apikey", this.apiKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }

    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        if (!res.ok) {
          // 429 = rate limited, 5xx = server issue — both retryable
          if (res.status === 429 || res.status >= 500) {
            lastErr = new Error(`HTTP ${res.status}`);
            await sleep(backoffMs(attempt));
            continue;
          }
          throw new Error(`HTTP ${res.status}: ${await res.text()}`);
        }
        const json = await res.json();
        // Etherscan returns { status, message, result }. status="0" with
        // message="No transactions found" is a valid empty result — NOT an error.
        if (json.status === "1") return json.result;
        if (json.status === "0") {
          const msg = String(json.message || "").toLowerCase();
          if (msg.includes("no transactions") || msg.includes("no records")) return [];
          if (msg.includes("rate limit") || msg.includes("max rate") || msg.includes("max calls")) {
            lastErr = new Error(`rate-limited: ${json.message}`);
            await sleep(backoffMs(attempt));
            continue;
          }
          // Other status=0 — surface as error
          throw new Error(`Etherscan: ${json.message} | ${JSON.stringify(json.result)}`);
        }
        return json.result ?? [];
      } catch (err) {
        lastErr = err;
        if (attempt < retries) await sleep(backoffMs(attempt));
      }
    }
    throw lastErr ?? new Error("Etherscan call failed");
  }

  // Paginate by block cursor — reliable past the 10k-row flat cap.
  async _paginate(baseParams) {
    const all = [];
    let startblock = 0;
    const seen = new Set();
    while (true) {
      const batch = await this._call({
        ...baseParams,
        startblock,
        endblock: 99999999,
        page: 1,
        offset: PAGE_LIMIT,
        sort: "asc",
      });
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const row of batch) {
        // hash+logIndex is unique; fall back to hash+from+to+value for native txs
        const key = `${row.hash}:${row.logIndex ?? ""}:${row.from ?? ""}:${row.to ?? ""}:${row.value ?? ""}:${row.tokenID ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        all.push(row);
      }

      if (batch.length < PAGE_LIMIT) break;
      // Advance cursor to the next block after the last row in this batch.
      const lastBlock = Number(batch[batch.length - 1].blockNumber);
      if (!Number.isFinite(lastBlock) || lastBlock + 1 <= startblock) break;
      startblock = lastBlock + 1;
    }
    return all;
  }

  nativeTxs(address) {
    return this._paginate({ module: "account", action: "txlist", address });
  }
  internalTxs(address) {
    return this._paginate({ module: "account", action: "txlistinternal", address });
  }
  erc20Txs(address) {
    return this._paginate({ module: "account", action: "tokentx", address });
  }
  erc721Txs(address) {
    return this._paginate({ module: "account", action: "tokennfttx", address });
  }
  erc1155Txs(address) {
    return this._paginate({ module: "account", action: "token1155tx", address });
  }

  async isContract(address) {
    const code = await this._call({ module: "proxy", action: "eth_getCode", address, tag: "latest" });
    return typeof code === "string" && code !== "0x" && code.length > 2;
  }

  async nativeBalance(address) {
    const wei = await this._call({ module: "account", action: "balance", address, tag: "latest" });
    return BigInt(wei ?? "0");
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function backoffMs(attempt) {
  return Math.min(30_000, 500 * Math.pow(2, attempt)) + Math.random() * 250;
}
