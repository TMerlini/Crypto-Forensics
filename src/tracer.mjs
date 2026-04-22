// Importable tracer core.
// Used by both the CLI (trace.mjs) and the HTTP server (server.mjs).
//
// Emits progress events via a callback so the UI can stream live updates over SSE.

import { Etherscan } from "./etherscan.mjs";
import { labelOf, isOrigin } from "./labels.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";

export async function runTrace({
  apiKey,
  chainId,
  scamAddress,
  maxDepth = 15,
  maxAddresses = 2000,
  rps = 4,
  stopAtOrigin = true,
  fromTs = null,
  toTs = null,
  direction = "in",   // "in" | "out" | "both"
  onProgress = () => {},
  onCheckpoint = () => {},
  checkpointEvery = 25,
  onAbort = () => false,
  resumeFrom = null,
}) {
  const target = scamAddress.toLowerCase();
  const client = new Etherscan({ apiKey, chainId, rps });

  const state = resumeFrom ?? {
    nodes: {},
    edges: [],
    visited: [],
    queue: [{ address: target, depth: 0 }],
    stats: { expanded: 0, txsFetched: 0, startedAt: new Date().toISOString() },
  };
  const visitedSet = new Set(state.visited);

  addNode(state, target, 0, { isScam: true });

  onProgress({
    type: "start",
    target,
    chainId,
    maxDepth,
    maxAddresses,
    direction,
    stopAtOrigin,
  });

  while (state.queue.length > 0) {
    if (onAbort()) {
      onProgress({ type: "aborted" });
      return state;
    }
    if (state.stats.expanded >= maxAddresses) {
      onProgress({ type: "cap-reached", cap: maxAddresses });
      break;
    }

    const { address, depth } = state.queue.shift();
    if (visitedSet.has(address)) continue;
    visitedSet.add(address);
    state.visited.push(address);

    const label = labelOf(address);
    if (address === ZERO) continue;
    if (stopAtOrigin && address !== target && label && isOrigin(address)) {
      const n = state.nodes[address];
      if (n) n.terminatedBy = `origin:${label.category}`;
      continue;
    }

    const isContract = await client.isContract(address).catch(() => false);
    const n = state.nodes[address];
    if (n) n.isContract = isContract;

    if (stopAtOrigin && address !== target && isContract) {
      if (n) n.terminatedBy = n.terminatedBy ?? "contract";
      continue;
    }

    state.stats.expanded++;
    onProgress({
      type: "expand",
      address,
      depth,
      queueSize: state.queue.length,
      expanded: state.stats.expanded,
      cap: maxAddresses,
      label: label ? `${label.category}:${label.name}` : null,
    });

    try {
      const [nativeTxs, internalTxs, erc20, erc721, erc1155] = await Promise.all([
        client.nativeTxs(address),
        client.internalTxs(address),
        client.erc20Txs(address),
        client.erc721Txs(address),
        client.erc1155Txs(address),
      ]);
      state.stats.txsFetched += nativeTxs.length + internalTxs.length + erc20.length + erc721.length + erc1155.length;

      const ingestors = [
        ["native", nativeTxs],
        ["internal", internalTxs],
        ["erc20", erc20],
        ["erc721", erc721],
        ["erc1155", erc1155],
      ];
      let count = 0;
      for (const [kind, rows] of ingestors) {
        count += ingest({
          state,
          address,
          depth,
          kind,
          rows,
          direction,
          maxDepth,
          fromTs,
          toTs,
          visitedSet,
        });
      }

      onProgress({ type: "expanded", address, inflows: count });
      if (state.stats.expanded % checkpointEvery === 0) onCheckpoint(state);
    } catch (err) {
      onProgress({ type: "error", address, error: err.message });
      if (n) n.error = err.message;
    }
  }

  state.stats.finishedAt = new Date().toISOString();
  onProgress({
    type: "done",
    nodes: Object.keys(state.nodes).length,
    edges: state.edges.length,
    txsFetched: state.stats.txsFetched,
  });

  return state;
}

// -----------------------------------------------------------------------------
// Ingest: record transfers that match the configured direction.
// -----------------------------------------------------------------------------
// For direction = "in":  we keep edges where tx.to   == address, and enqueue tx.from
// For direction = "out": we keep edges where tx.from == address, and enqueue tx.to
// For direction = "both": both
// -----------------------------------------------------------------------------
function ingest({ state, address, depth, kind, rows, direction, maxDepth, fromTs, toTs, visitedSet }) {
  let count = 0;
  for (const tx of rows) {
    const from = (tx.from ?? "").toLowerCase();
    const to = (tx.to ?? "").toLowerCase();
    const ts = Number(tx.timeStamp);
    if (fromTs && ts < fromTs) continue;
    if (toTs && ts > toTs) continue;
    if ((kind === "native" || kind === "internal") && tx.isError === "1") continue;

    const amount = BigInt(pickAmount(tx, kind) ?? "0");
    if (amount === 0n && kind !== "erc721" && kind !== "erc1155") continue;

    const edge = buildEdge(tx, kind, amount);
    if (!edge) continue;

    const inbound = to === address && from !== address && from !== ZERO;
    const outbound = from === address && to !== address && to !== ZERO;

    if (inbound && (direction === "in" || direction === "both")) {
      edge.direction = "in";
      state.edges.push(edge);
      touchNode(state, from, ts);
      addNode(state, from, depth + 1);
      maybeEnqueue(state, visitedSet, from, depth + 1, maxDepth);
      count++;
    }
    if (outbound && (direction === "out" || direction === "both")) {
      edge.direction = "out";
      state.edges.push(edge);
      touchNode(state, to, ts);
      addNode(state, to, depth + 1);
      maybeEnqueue(state, visitedSet, to, depth + 1, maxDepth);
      count++;
    }
  }
  return count;
}

function pickAmount(tx, kind) {
  if (kind === "erc721") return "1";
  if (kind === "erc1155") return tx.tokenValue ?? tx.value ?? "1";
  return tx.value ?? "0";
}

function buildEdge(tx, kind, amount) {
  const base = {
    from: tx.from.toLowerCase(),
    to: (tx.to ?? "").toLowerCase(),
    hash: tx.hash,
    block: Number(tx.blockNumber),
    ts: Number(tx.timeStamp),
    kind,
    amount: amount.toString(),
  };
  if (kind === "native") return { ...base, asset: "ETH", symbol: "ETH", decimals: 18 };
  if (kind === "internal") return { ...base, asset: "ETH", symbol: "ETH (internal)", decimals: 18 };
  if (kind === "erc20") {
    return {
      ...base,
      asset: tx.contractAddress.toLowerCase(),
      symbol: tx.tokenSymbol || "?",
      decimals: Number(tx.tokenDecimal ?? 18),
    };
  }
  if (kind === "erc721") {
    return {
      ...base,
      asset: tx.contractAddress.toLowerCase(),
      symbol: tx.tokenSymbol || "NFT",
      tokenId: tx.tokenID,
      decimals: 0,
    };
  }
  if (kind === "erc1155") {
    return {
      ...base,
      asset: tx.contractAddress.toLowerCase(),
      symbol: tx.tokenSymbol || "ERC-1155",
      tokenId: tx.tokenID,
      decimals: 0,
    };
  }
  return null;
}

function addNode(state, address, depth, extra = {}) {
  const key = address.toLowerCase();
  if (!state.nodes[key]) {
    const label = labelOf(key);
    state.nodes[key] = {
      address: key,
      depth,
      label: label?.name ?? null,
      category: label?.category ?? null,
      isScam: !!extra.isScam,
    };
  } else if (depth < state.nodes[key].depth) {
    state.nodes[key].depth = depth;
  }
}

function touchNode(state, address, ts) {
  const n = state.nodes[address];
  if (!n) return;
  n.firstSeenTs = n.firstSeenTs ? Math.min(n.firstSeenTs, ts) : ts;
  n.lastSeenTs = n.lastSeenTs ? Math.max(n.lastSeenTs, ts) : ts;
}

function maybeEnqueue(state, visitedSet, address, depth, maxDepth) {
  if (depth > maxDepth) return;
  if (visitedSet.has(address)) return;
  if (state.queue.some((q) => q.address === address)) return;
  state.queue.push({ address, depth });
}
