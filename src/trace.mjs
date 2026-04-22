#!/usr/bin/env node
// CLI entry point. Wires env + checkpointing + runTrace() + report writing.

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./env.mjs";
import { runTrace } from "./tracer.mjs";
import { writeReports } from "./report.mjs";

const env = loadEnv();
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, "..", "out");
mkdirSync(outDir, { recursive: true });

const shortScam = env.scamAddress.slice(0, 6) + env.scamAddress.slice(-4);
const checkpointPath = join(outDir, `trace-${shortScam}-${env.direction}.checkpoint.json`);

console.log(`[trace] chain=${env.chainId} target=${env.scamAddress} direction=${env.direction} maxDepth=${env.maxDepth} maxAddresses=${env.maxAddresses} rps=${env.rps} stopAtOrigin=${env.stopAtOrigin}`);
console.log(`[trace] output dir: ${outDir}`);

let aborting = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (aborting) process.exit(130);
    aborting = true;
    console.log(`\n[trace] ${sig} received — will checkpoint and exit after current request.`);
  });
}

const resumeFrom = loadCheckpoint();

try {
  const state = await runTrace({
    apiKey: env.apiKey,
    chainId: env.chainId,
    scamAddress: env.scamAddress,
    maxDepth: env.maxDepth,
    maxAddresses: env.maxAddresses,
    rps: env.rps,
    stopAtOrigin: env.stopAtOrigin,
    fromTs: env.fromTs,
    toTs: env.toTs,
    direction: env.direction,
    resumeFrom,
    onAbort: () => aborting,
    onCheckpoint: saveCheckpoint,
    onProgress: (ev) => {
      if (ev.type === "expand") {
        process.stdout.write(
          `[trace] [${ev.expanded}/${ev.cap}] depth=${ev.depth} queue=${ev.queueSize} addr=${ev.address}${ev.label ? ` (${ev.label})` : ""} ... `,
        );
      } else if (ev.type === "expanded") {
        process.stdout.write(`${ev.inflows} transfers\n`);
      } else if (ev.type === "error") {
        process.stdout.write(`FAILED: ${ev.error}\n`);
      } else if (ev.type === "cap-reached") {
        console.log(`[trace] reached MAX_ADDRESSES cap (${ev.cap}).`);
      } else if (ev.type === "aborted") {
        console.log(`[trace] aborted by user.`);
      } else if (ev.type === "done") {
        console.log(`[trace] done. nodes=${ev.nodes} edges=${ev.edges} txsFetched=${ev.txsFetched}`);
      }
    },
  });

  saveCheckpoint(state);

  if (aborting) {
    console.log(`[trace] checkpoint saved. Re-run to resume.`);
    process.exit(130);
  }

  await writeReports({ state, env, outDir });
  console.log(`[trace] reports written to ${outDir}`);
} catch (err) {
  console.error(`\n[trace] FATAL: ${err.message}`);
  process.exit(1);
}

function saveCheckpoint(state) {
  if (!state) return;
  const snapshot = {
    nodes: state.nodes,
    edges: state.edges,
    visited: state.visited,
    queue: state.queue,
    stats: state.stats,
    env: {
      chainId: env.chainId,
      scamAddress: env.scamAddress,
      maxDepth: env.maxDepth,
      maxAddresses: env.maxAddresses,
      direction: env.direction,
    },
  };
  writeFileSync(checkpointPath, JSON.stringify(snapshot));
}

function loadCheckpoint() {
  if (!existsSync(checkpointPath)) return null;
  try {
    const s = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (s.env?.scamAddress !== env.scamAddress || s.env?.chainId !== env.chainId) {
      console.log("[trace] checkpoint is for a different target; ignoring.");
      return null;
    }
    if (s.env?.direction && s.env.direction !== env.direction) return null;
    console.log(`[trace] resuming: ${Object.keys(s.nodes).length} nodes, ${s.edges.length} edges, queue=${s.queue.length}`);
    return s;
  } catch {
    return null;
  }
}
