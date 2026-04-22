import { writeFileSync } from "node:fs";
import { join } from "node:path";

export async function writeReports({ state, env, outDir }) {
  const scam = env.scamAddress;
  const short = scam.slice(0, 6) + scam.slice(-4);
  const tag = `${short}-${env.direction ?? "in"}`;

  const analysis = analyze(state, scam, env.direction ?? "in");

  writeFileSync(
    join(outDir, `trace-${tag}.json`),
    JSON.stringify({ target: scam, chainId: env.chainId, direction: env.direction, analysis, nodes: state.nodes, edges: state.edges }, null, 2),
  );

  writeFileSync(join(outDir, `trace-${tag}.edges.csv`), edgesCsv(state.edges));
  writeFileSync(join(outDir, `trace-${tag}.nodes.csv`), nodesCsv(state.nodes));
  writeFileSync(join(outDir, `trace-${tag}.inflows-to-target.csv`), directEdgesCsv(state.edges, scam, "in"));
  writeFileSync(join(outDir, `trace-${tag}.outflows-from-target.csv`), directEdgesCsv(state.edges, scam, "out"));
  writeFileSync(join(outDir, `trace-${tag}.report.md`), markdownReport({ state, env, analysis }));
}

// -----------------------------------------------------------------------------
// Analyzer
// -----------------------------------------------------------------------------
export function analyze(state, scam, direction = "in") {
  const edges = state.edges;
  const scamInflows = edges.filter((e) => e.to === scam).sort((a, b) => a.ts - b.ts);
  const scamOutflows = edges.filter((e) => e.from === scam).sort((a, b) => a.ts - b.ts);

  // Totals by asset for each direction
  const inByAsset = sumByAsset(scamInflows);
  const outByAsset = sumByAsset(scamOutflows);

  // Victim vs attacker-funded split (inflows only)
  const victimByAsset = {};
  const victimAddresses = new Set();
  for (const e of scamInflows) {
    const senderNode = state.nodes[e.from];
    const isKnownOrigin = senderNode?.category === "cex" || senderNode?.category === "bridge";
    if (isKnownOrigin) continue;
    const key = assetKey(e);
    if (!victimByAsset[key]) victimByAsset[key] = { asset: e.asset, symbol: e.symbol, decimals: e.decimals, amount: 0n, count: 0 };
    victimByAsset[key].amount += BigInt(e.amount);
    victimByAsset[key].count += 1;
    victimAddresses.add(e.from);
  }

  // Attacker's gas-seed trail (based on earliest inflow)
  const firstInflow = scamInflows[0] ?? null;
  const gasSeedChain = firstInflow ? buildAncestryChain(state, firstInflow.from, "in") : [];

  // Cash-out destinations (based on outflows)
  const cashOutChain = buildCashoutChain(state, scam);
  const cashOutEndpoints = {};
  for (const e of scamOutflows) {
    const dest = e.to;
    const destNode = state.nodes[dest];
    if (!destNode) continue;
    if (destNode.category === "cex" || destNode.category === "bridge" || destNode.category === "mixer") {
      const key = `${destNode.category}:${destNode.label}`;
      if (!cashOutEndpoints[key]) {
        cashOutEndpoints[key] = { address: dest, label: destNode.label, category: destNode.category, edges: [], totals: {} };
      }
      cashOutEndpoints[key].edges.push({ hash: e.hash, ts: e.ts, symbol: e.symbol, amount: e.amount, decimals: e.decimals, kind: e.kind });
      const aKey = assetKey(e);
      if (!cashOutEndpoints[key].totals[aKey]) cashOutEndpoints[key].totals[aKey] = { symbol: e.symbol, amount: 0n, decimals: e.decimals };
      cashOutEndpoints[key].totals[aKey].amount += BigInt(e.amount);
    }
  }
  // serialize bigints
  for (const ep of Object.values(cashOutEndpoints)) {
    for (const k of Object.keys(ep.totals)) {
      const t = ep.totals[k];
      ep.totals[k] = { symbol: t.symbol, amount: t.amount.toString(), amountFormatted: formatUnits(t.amount, t.decimals ?? 18), decimals: t.decimals };
    }
  }

  // Top ETH senders / recipients
  const topEthFunders = topByEth(scamInflows, (e) => e.from, state);
  const topEthRecipients = topByEth(scamOutflows, (e) => e.to, state);

  return {
    direction,
    totals: {
      inflowCount: scamInflows.length,
      outflowCount: scamOutflows.length,
      uniqueSendersToTarget: new Set(scamInflows.map((e) => e.from)).size,
      uniqueRecipientsFromTarget: new Set(scamOutflows.map((e) => e.to)).size,
      uniqueVictimAddresses: victimAddresses.size,
      nodesDiscovered: Object.keys(state.nodes).length,
      edgesDiscovered: edges.length,
      firstInflowAt: firstInflow ? new Date(firstInflow.ts * 1000).toISOString() : null,
      lastInflowAt: scamInflows.length ? new Date(scamInflows[scamInflows.length - 1].ts * 1000).toISOString() : null,
      firstOutflowAt: scamOutflows[0] ? new Date(scamOutflows[0].ts * 1000).toISOString() : null,
      lastOutflowAt: scamOutflows.length ? new Date(scamOutflows[scamOutflows.length - 1].ts * 1000).toISOString() : null,
    },
    inflowsByAsset: serializeAssetMap(inByAsset),
    outflowsByAsset: serializeAssetMap(outByAsset),
    victimInflowsByAsset: serializeAssetMap(victimByAsset),
    firstInflow: firstInflow
      ? {
          from: firstInflow.from,
          hash: firstInflow.hash,
          ts: firstInflow.ts,
          time: new Date(firstInflow.ts * 1000).toISOString(),
          asset: firstInflow.symbol,
          amount: formatUnits(BigInt(firstInflow.amount), firstInflow.decimals ?? 18),
          kind: firstInflow.kind,
          note: "Almost certainly the attacker's gas-seed tx. Funder chain below is the trail back to the attacker's identity.",
        }
      : null,
    gasSeedChain,
    cashOutChain,
    cashOutEndpoints: Object.values(cashOutEndpoints),
    topEthFunders,
    topEthRecipients,
  };
}

function sumByAsset(list) {
  const out = {};
  for (const e of list) {
    const k = assetKey(e);
    if (!out[k]) out[k] = { asset: e.asset, symbol: e.symbol, decimals: e.decimals, amount: 0n, count: 0, kind: e.kind };
    out[k].amount += BigInt(e.amount);
    out[k].count += 1;
  }
  return out;
}

function topByEth(list, pickAddr, state, limit = 25) {
  const m = new Map();
  for (const e of list) {
    if (e.kind !== "native" && e.kind !== "internal") continue;
    const a = pickAddr(e);
    m.set(a, (m.get(a) ?? 0n) + BigInt(e.amount));
  }
  return [...m.entries()]
    .sort((a, b) => (b[1] > a[1] ? 1 : -1))
    .slice(0, limit)
    .map(([addr, amt]) => ({ address: addr, eth: formatUnits(amt, 18), wei: amt.toString(), label: state.nodes[addr]?.label ?? null, category: state.nodes[addr]?.category ?? null }));
}

// Follow earliest inflow at each hop (attacker gas seed path)
function buildAncestryChain(state, startAddress, direction) {
  const chain = [];
  const seen = new Set();
  let current = startAddress;
  let hop = 0;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = state.nodes[current];
    const inflows = state.edges
      .filter((e) => e.to === current && e.from !== current)
      .sort((a, b) => a.ts - b.ts);
    const firstFunder = inflows[0] ?? null;
    chain.push({
      hop,
      address: current,
      label: node?.label ? `${node.category}:${node.label}` : null,
      depth: node?.depth ?? null,
      isContract: node?.isContract ?? null,
      firstInflow: firstFunder ? serializeEdgeHop(firstFunder) : null,
      terminated: node?.terminatedBy ?? null,
    });
    if (node?.category === "cex" || node?.category === "bridge" || node?.category === "mixer") break;
    if (!firstFunder) break;
    current = firstFunder.from;
    hop++;
    if (hop > 50) break;
  }
  return chain;
}

// Follow earliest-with-value outflow at each hop (where did the money go?)
function buildCashoutChain(state, startAddress) {
  const chain = [];
  const seen = new Set();
  let current = startAddress;
  let hop = 0;
  while (current && !seen.has(current)) {
    seen.add(current);
    const node = state.nodes[current];
    const outflows = state.edges
      .filter((e) => e.from === current && e.to !== current)
      .sort((a, b) => {
        // prefer native ETH, then higher value
        if (a.kind === b.kind) return BigInt(b.amount) > BigInt(a.amount) ? 1 : -1;
        if (a.kind === "native") return -1;
        if (b.kind === "native") return 1;
        return BigInt(b.amount) > BigInt(a.amount) ? 1 : -1;
      });
    const biggest = outflows[0] ?? null;
    chain.push({
      hop,
      address: current,
      label: node?.label ? `${node.category}:${node.label}` : null,
      depth: node?.depth ?? null,
      isContract: node?.isContract ?? null,
      biggestOutflow: biggest ? { ...serializeEdgeHop(biggest), to: biggest.to } : null,
      terminated: node?.terminatedBy ?? null,
    });
    if (node?.category === "cex" || node?.category === "bridge" || node?.category === "mixer") break;
    if (!biggest) break;
    current = biggest.to;
    hop++;
    if (hop > 50) break;
  }
  return chain;
}

function serializeEdgeHop(e) {
  return {
    from: e.from,
    to: e.to,
    hash: e.hash,
    time: new Date(e.ts * 1000).toISOString(),
    asset: e.symbol,
    amount: formatUnits(BigInt(e.amount), e.decimals ?? 18),
    kind: e.kind,
  };
}

function assetKey(e) {
  if (e.kind === "native" || e.kind === "internal") return "ETH";
  if (e.kind === "erc721") return `NFT:${e.asset}:${e.tokenId}`;
  if (e.kind === "erc1155") return `1155:${e.asset}:${e.tokenId}`;
  return `ERC20:${e.asset}`;
}

function serializeAssetMap(m) {
  return Object.values(m).map((v) => ({
    asset: v.asset,
    symbol: v.symbol,
    decimals: v.decimals,
    amount: typeof v.amount === "bigint" ? v.amount.toString() : String(v.amount),
    amountFormatted: formatUnits(typeof v.amount === "bigint" ? v.amount : BigInt(v.amount ?? "0"), v.decimals ?? 18),
    count: v.count,
    kind: v.kind,
  }));
}

export function formatUnits(value, decimals) {
  if (typeof value !== "bigint") value = BigInt(value ?? "0");
  const d = BigInt(decimals ?? 0);
  if (d === 0n) return value.toString();
  const divisor = 10n ** d;
  const whole = value / divisor;
  const frac = (value % divisor).toString().padStart(Number(d), "0").replace(/0+$/, "");
  return frac.length ? `${whole.toString()}.${frac}` : whole.toString();
}

// -----------------------------------------------------------------------------
// CSV writers
// -----------------------------------------------------------------------------
function edgesCsv(edges) {
  const header = "ts,time_utc,block,hash,from,to,direction,kind,symbol,asset,decimals,raw_amount,formatted_amount,token_id";
  const rows = edges.map(
    (e) =>
      [
        e.ts,
        new Date(e.ts * 1000).toISOString(),
        e.block,
        e.hash,
        e.from,
        e.to,
        e.direction ?? "",
        e.kind,
        csv(e.symbol),
        e.asset,
        e.decimals ?? "",
        e.amount,
        formatUnits(BigInt(e.amount), e.decimals ?? 18),
        e.tokenId ?? "",
      ].join(","),
  );
  return [header, ...rows].join("\n");
}

function nodesCsv(nodes) {
  const header = "address,depth,category,label,is_contract,is_scam,first_seen_ts,last_seen_ts,terminated_by";
  const rows = Object.values(nodes).map((n) =>
    [
      n.address,
      n.depth,
      n.category ?? "",
      csv(n.label ?? ""),
      n.isContract ?? "",
      n.isScam ? "true" : "",
      n.firstSeenTs ?? "",
      n.lastSeenTs ?? "",
      n.terminatedBy ?? "",
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function directEdgesCsv(edges, scam, dir) {
  const filtered = edges
    .filter((e) => (dir === "in" ? e.to === scam : e.from === scam))
    .sort((a, b) => a.ts - b.ts);
  const other = dir === "in" ? "from" : "to";
  const header = `time_utc,${other},kind,symbol,raw_amount,formatted_amount,tx_hash,token_id`;
  const rows = filtered.map((e) =>
    [
      new Date(e.ts * 1000).toISOString(),
      e[other],
      e.kind,
      csv(e.symbol),
      e.amount,
      formatUnits(BigInt(e.amount), e.decimals ?? 18),
      e.hash,
      e.tokenId ?? "",
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function csv(s) {
  if (s == null) return "";
  const v = String(s);
  if (v.includes(",") || v.includes('"') || v.includes("\n")) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

// -----------------------------------------------------------------------------
// Markdown report
// -----------------------------------------------------------------------------
function markdownReport({ state, env, analysis }) {
  const scam = env.scamAddress;
  const L = [];
  L.push(`# Sweeper Trace: \`${scam}\``);
  L.push("");
  L.push(`- Chain ID: \`${env.chainId}\``);
  L.push(`- Direction: \`${analysis.direction}\``);
  L.push(`- Crawl depth limit: ${env.maxDepth}`);
  L.push(`- Addresses expanded: ${state.stats.expanded}`);
  L.push(`- Nodes discovered: ${analysis.totals.nodesDiscovered}`);
  L.push(`- Transfer edges: ${analysis.totals.edgesDiscovered}`);
  L.push(`- Inflows: ${analysis.totals.inflowCount} (${analysis.totals.uniqueSendersToTarget} unique senders)`);
  L.push(`- Outflows: ${analysis.totals.outflowCount} (${analysis.totals.uniqueRecipientsFromTarget} unique recipients)`);
  L.push(`- Likely victims: ${analysis.totals.uniqueVictimAddresses}`);
  L.push(`- First inflow: ${analysis.totals.firstInflowAt ?? "(none)"}`);
  L.push(`- Last inflow: ${analysis.totals.lastInflowAt ?? "(none)"}`);
  L.push("");

  L.push(`## Received by target (by asset)`);
  L.push("");
  L.push(table(["Symbol", "Amount", "Transfers", "Contract"], analysis.inflowsByAsset.map((a) => [a.symbol, a.amountFormatted, a.count, `\`${a.asset}\``])));
  L.push("");

  L.push(`## Sent from target (by asset) — where the money went`);
  L.push("");
  L.push(table(["Symbol", "Amount", "Transfers", "Contract"], analysis.outflowsByAsset.map((a) => [a.symbol, a.amountFormatted, a.count, `\`${a.asset}\``])));
  L.push("");

  L.push(`## Inflows from non-CEX senders (likely stolen from victims)`);
  L.push("");
  L.push(table(["Symbol", "Amount", "Transfers", "Contract"], analysis.victimInflowsByAsset.map((a) => [a.symbol, a.amountFormatted, a.count, `\`${a.asset}\``])));
  L.push("");

  L.push(`## Attacker's gas-seed trail (first inflow backwards)`);
  L.push("");
  if (!analysis.firstInflow) {
    L.push("_No inflows found._");
  } else {
    L.push(`- From: \`${analysis.firstInflow.from}\``);
    L.push(`- When: ${analysis.firstInflow.time}`);
    L.push(`- Amount: ${analysis.firstInflow.amount} ${analysis.firstInflow.asset}`);
    L.push(`- Tx: https://etherscan.io/tx/${analysis.firstInflow.hash}`);
    L.push("");
    for (const hop of analysis.gasSeedChain) {
      L.push(`${"  ".repeat(hop.hop)}↳ hop ${hop.hop}: \`${hop.address}\`${hop.label ? ` — **${hop.label}**` : ""}${hop.isContract ? " _(contract)_" : ""}`);
      if (hop.firstInflow) {
        L.push(`${"  ".repeat(hop.hop + 1)}• funded by \`${hop.firstInflow.from}\` with ${hop.firstInflow.amount} ${hop.firstInflow.asset} on ${hop.firstInflow.time} — [tx](https://etherscan.io/tx/${hop.firstInflow.hash})`);
      }
    }
  }
  L.push("");

  L.push(`## Cash-out trail (biggest outflow forwards)`);
  L.push("");
  if (!analysis.cashOutChain.length || !analysis.cashOutChain[0].biggestOutflow) {
    L.push("_No outflows discovered. (Did you trace with DIRECTION=out or both?)_");
  } else {
    for (const hop of analysis.cashOutChain) {
      L.push(`${"  ".repeat(hop.hop)}↳ hop ${hop.hop}: \`${hop.address}\`${hop.label ? ` — **${hop.label}**` : ""}${hop.isContract ? " _(contract)_" : ""}`);
      if (hop.biggestOutflow) {
        L.push(`${"  ".repeat(hop.hop + 1)}• sent ${hop.biggestOutflow.amount} ${hop.biggestOutflow.asset} → \`${hop.biggestOutflow.to}\` on ${hop.biggestOutflow.time} — [tx](https://etherscan.io/tx/${hop.biggestOutflow.hash})`);
      }
    }
  }
  L.push("");

  L.push(`## Cash-out endpoints (CEX / bridge / mixer)`);
  L.push("");
  if (!analysis.cashOutEndpoints.length) {
    L.push("_None found. The attacker hasn't cashed out through a labelled venue yet, or you need to trace with DIRECTION=out._");
  } else {
    for (const ep of analysis.cashOutEndpoints) {
      L.push(`- **${ep.category}:${ep.label}** — \`${ep.address}\``);
      for (const t of Object.values(ep.totals)) {
        L.push(`  - ${t.amountFormatted} ${t.symbol}`);
      }
    }
  }
  L.push("");

  L.push(`## Top ETH funders of the target`);
  L.push("");
  L.push(table(["#", "Address", "ETH", "Label"], analysis.topEthFunders.map((f, i) => [i + 1, `\`${f.address}\``, f.eth, f.label ?? ""])));
  L.push("");

  L.push(`## Top ETH recipients from the target`);
  L.push("");
  L.push(table(["#", "Address", "ETH", "Label"], analysis.topEthRecipients.map((f, i) => [i + 1, `\`${f.address}\``, f.eth, f.label ?? ""])));
  L.push("");

  L.push(`## Next steps`);
  L.push("");
  L.push("1. **Cash-out endpoints** tab above — if the attacker deposited into a CEX, that exchange's compliance team has KYC on the attacker. File immediately with `abuse@<exchange>`, attach the `outflows-from-target.csv`.");
  L.push("2. **Gas-seed trail** — if the *first* inflow chain ends at a CEX, that's the other half of the identity link (where the attacker withdrew the gas money from).");
  L.push("3. Notify USDC (Circle) / USDT (Tether) if stablecoins are visible at any attacker-controlled address — they can freeze. Act within hours, not days.");
  L.push("4. File with IC3 (US) / Action Fraud (UK) / your local cybercrime unit. Attach the Markdown report + CSVs.");

  return L.join("\n");
}

function table(headers, rows) {
  const h = `| ${headers.join(" | ")} |`;
  const s = `|${headers.map(() => "---").join("|")}|`;
  const body = rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return [h, s, body].join("\n");
}
