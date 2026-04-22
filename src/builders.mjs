// Block-builder submission layer.
//
// Each builder exposes a JSON-RPC endpoint that accepts `eth_sendBundle`. Flashbots
// additionally requires an `X-Flashbots-Signature` header signed by any Ethereum
// key (used only for reputation tracking — it doesn't authorise the bundle, the
// actual transactions sign themselves).
//
// We submit the SAME bundle to every builder in parallel. Inclusion from any one
// builder is sufficient — whichever builder wins the auction for a given slot
// includes our bundle, and the transactions land on-chain exactly once.

import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

// Canonical list. Ordered by typical block market share on Ethereum mainnet.
// Update as the builder landscape changes.
export const DEFAULT_BUILDERS = [
  { id: "flashbots",   url: "https://relay.flashbots.net",          signed: true,  label: "Flashbots Relay" },
  { id: "beaverbuild", url: "https://rpc.beaverbuild.org",          signed: false, label: "beaverbuild" },
  { id: "titan",       url: "https://rpc.titanbuilder.xyz",         signed: true,  label: "Titan Builder" },
  { id: "rsync",       url: "https://rsync-builder.xyz",            signed: false, label: "rsync-builder" },
  { id: "builder69",   url: "https://builder0x69.io",               signed: false, label: "builder0x69" },
  { id: "buildernet",  url: "https://buildernet.org",               signed: true,  label: "BuilderNet" },
  { id: "payload",     url: "https://rpc.payload.de",               signed: false, label: "Payload" },
  { id: "loki",        url: "https://rpc.lokibuilder.xyz",          signed: false, label: "Loki" },
];

// Sepolia builder endpoints for testing. Flashbots Protect has a Sepolia relay.
export const SEPOLIA_BUILDERS = [
  { id: "flashbots-sepolia", url: "https://relay-sepolia.flashbots.net", signed: true, label: "Flashbots Sepolia" },
];

export function buildersForChain(chainId) {
  if (chainId === 1) return DEFAULT_BUILDERS;
  if (chainId === 11155111) return SEPOLIA_BUILDERS;
  return [];
}

// -----------------------------------------------------------------------------
// Submit one bundle to one builder for one target block.
// -----------------------------------------------------------------------------
export async function submitBundle({
  builder,
  signedRawTxs,           // array of 0x-prefixed raw signed txs
  targetBlockNumber,      // number | bigint
  minTimestamp = 0,
  maxTimestamp = 0,
  revertingTxHashes = [],
  searcherSigningKey,     // 0x... any ethereum private key, for X-Flashbots-Signature
  timeoutMs = 5000,
}) {
  const blockHex = "0x" + BigInt(targetBlockNumber).toString(16);
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_sendBundle",
    params: [{
      txs: signedRawTxs,
      blockNumber: blockHex,
      minTimestamp,
      maxTimestamp,
      revertingTxHashes,
    }],
  };
  const bodyText = JSON.stringify(body);
  const headers = { "content-type": "application/json" };

  if (builder.signed) {
    if (!searcherSigningKey) throw new Error(`${builder.id} requires a searcher signing key`);
    const sig = await flashbotsSignature(bodyText, searcherSigningKey);
    headers["X-Flashbots-Signature"] = sig;
  }

  const controller = new AbortController();
  const tm = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(builder.url, { method: "POST", headers, body: bodyText, signal: controller.signal });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return {
      builder: builder.id,
      block: Number(targetBlockNumber),
      ok: res.ok && !json.error,
      status: res.status,
      result: json?.result ?? null,
      error: json?.error?.message ?? (res.ok ? null : `HTTP ${res.status}`),
    };
  } catch (err) {
    return {
      builder: builder.id,
      block: Number(targetBlockNumber),
      ok: false,
      status: 0,
      error: err.name === "AbortError" ? "timeout" : err.message,
    };
  } finally {
    clearTimeout(tm);
  }
}

// -----------------------------------------------------------------------------
// Simulate via Flashbots `eth_callBundle` — tells us if txs revert, gas used, etc.
// This is the safest way to preview a bundle before sending real money.
// -----------------------------------------------------------------------------
export async function simulateBundle({
  signedRawTxs,
  blockNumber,                   // number | bigint — target block (usually latest + 1)
  stateBlockNumber = "latest",
  searcherSigningKey,
  timeoutMs = 10_000,
}) {
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "eth_callBundle",
    params: [{
      txs: signedRawTxs,
      blockNumber: "0x" + BigInt(blockNumber).toString(16),
      stateBlockNumber,
    }],
  };
  const bodyText = JSON.stringify(body);
  const sig = await flashbotsSignature(bodyText, searcherSigningKey);
  const controller = new AbortController();
  const tm = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://relay.flashbots.net", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Flashbots-Signature": sig,
      },
      body: bodyText,
      signal: controller.signal,
    });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { ok: res.ok && !json.error, status: res.status, result: json?.result ?? null, error: json?.error?.message ?? null };
  } catch (err) {
    return { ok: false, status: 0, error: err.message };
  } finally {
    clearTimeout(tm);
  }
}

// -----------------------------------------------------------------------------
// Sign the Flashbots "X-Flashbots-Signature" header.
// Format: <signingAddress>:<hexSig>
// Signed message: "0x" + keccak256(rpcBody)
// -----------------------------------------------------------------------------
async function flashbotsSignature(bodyText, privateKey) {
  const account = privateKeyToAccount(privateKey);
  const hash = keccak256(toHex(bodyText));
  // viem signMessage auto-prefixes with the EIP-191 preamble, which is what
  // Flashbots expects (they verify via ecrecover on the prefixed hash).
  const sig = await account.signMessage({ message: hash });
  return `${account.address}:${sig}`;
}

// -----------------------------------------------------------------------------
// Fan-out: submit the same bundle to every builder for every target block.
// Yields results as they arrive (completion order, not submission order).
// -----------------------------------------------------------------------------
export async function* submitBundleToMany({
  builders,
  signedRawTxs,
  fromBlock,             // inclusive
  toBlock,               // inclusive
  searcherSigningKey,
  onAbort = () => false,
}) {
  const tasks = [];
  for (let b = BigInt(fromBlock); b <= BigInt(toBlock); b++) {
    for (const builder of builders) {
      if (onAbort()) return;
      const block = Number(b);
      tasks.push(
        submitBundle({ builder, signedRawTxs, targetBlockNumber: b, searcherSigningKey })
          .then((r) => ({ ...r, targetBlock: block })),
      );
    }
  }
  // Stream results as they arrive (completion order).
  const buffer = [];
  const waiters = [];
  let settled = 0;
  const total = tasks.length;

  for (const t of tasks) {
    t.then((val) => {
      if (waiters.length) waiters.shift()(val);
      else buffer.push(val);
      settled++;
    }).catch((err) => {
      const val = { ok: false, error: err.message ?? String(err) };
      if (waiters.length) waiters.shift()(val);
      else buffer.push(val);
      settled++;
    });
  }

  while (settled < total || buffer.length > 0) {
    if (onAbort()) return;
    if (buffer.length) {
      yield buffer.shift();
    } else {
      const v = await new Promise((resolve) => waiters.push(resolve));
      yield v;
    }
  }
}
