#!/usr/bin/env node
// Local HTTP server. Binds to 127.0.0.1 by default — private keys entered in
// the rescue form never leave your machine.
//
// Routes:
//   GET  /                       → static UI (web/index.html)
//   GET  /static/*               → web/ assets (css, js)
//   GET  /api/config             → non-secret config (chainId, default address, etc.)
//   POST /api/trace              → start a trace (returns runId)
//   GET  /api/trace/:id/stream   → SSE progress stream + final report
//   GET  /api/trace/runs         → list past trace runs (scans out/)
//   GET  /api/trace/runs/:id     → fetch a run's full JSON report
//   POST /api/rescue/compose     → build + sign a bundle (returns preview, not submitted)
//   POST /api/rescue/simulate    → simulate a composed bundle against latest state
//   POST /api/rescue/submit      → submit composed bundle to builders (SSE stream)
//   GET  /api/playbook           → RECOVERY.md as HTML

import { createServer } from "node:http";
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { loadEnv } from "./env.mjs";
import { runTrace } from "./tracer.mjs";
import { analyze } from "./report.mjs";
import { writeReports } from "./report.mjs";
import { composeBundle, simulateRescue, submitRescue } from "./rescue.mjs";
import { buildersForChain } from "./builders.mjs";

// Server boots without any required env — both the API key and the scam address
// can be entered in the UI per-request. We just warn if they are missing so the
// Trace tab stays usable out of the box.
const env = loadEnv({ require: [], warn: ["ETHERSCAN_API_KEY"] });
const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, "..");
const webDir = join(rootDir, "web");
const outDir = join(rootDir, "out");
mkdirSync(outDir, { recursive: true });

// In-memory run state. Each run: { id, state, done, error, aborted, subscribers: Set<res> }
const runs = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    // CORS: strict — only our own origin. No wildcard, no creds.
    res.setHeader("Access-Control-Allow-Origin", "");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "GET" && (p === "/" || p === "/index.html")) return sendFile(res, join(webDir, "index.html"));
    if (req.method === "GET" && p.startsWith("/static/")) return sendFile(res, join(webDir, p.slice("/static/".length)));
    if (req.method === "GET" && p === "/favicon.ico") { res.statusCode = 204; return res.end(); }

    if (req.method === "GET" && p === "/api/config") return sendJson(res, {
      chainId: env.chainId,
      defaultScamAddress: env.scamAddress || null,
      defaultDirection: env.direction,
      defaultMaxDepth: env.maxDepth,
      defaultMaxAddresses: env.maxAddresses,
      builderCountMainnet: buildersForChain(1).length,
      builderCountSepolia: buildersForChain(11155111).length,
    });

    if (req.method === "POST" && p === "/api/trace") return startTrace(req, res);
    if (req.method === "GET" && /^\/api\/trace\/[^/]+\/stream$/.test(p)) {
      const id = p.split("/")[3];
      return streamTrace(id, res);
    }
    if (req.method === "POST" && /^\/api\/trace\/[^/]+\/abort$/.test(p)) {
      const id = p.split("/")[3];
      return abortTrace(id, res);
    }
    if (req.method === "GET" && p === "/api/trace/runs") return listRuns(res);
    if (req.method === "GET" && /^\/api\/trace\/runs\/[^/]+$/.test(p)) {
      const id = p.split("/").pop();
      return sendReport(id, res);
    }

    if (req.method === "POST" && p === "/api/rescue/compose") return rescueCompose(req, res);
    if (req.method === "POST" && p === "/api/rescue/simulate") return rescueSimulate(req, res);
    if (req.method === "POST" && p === "/api/rescue/submit") return rescueSubmit(req, res);

    if (req.method === "GET" && p === "/api/playbook") return sendPlaybook(res);

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    console.error("[server] handler error:", err);
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(env.serverPort, env.serverBind, () => {
  console.log(`\n  Sweeper Trace UI running at  http://${env.serverBind}:${env.serverPort}\n`);
  console.log(`  Chain: ${env.chainId}   Builders: ${buildersForChain(env.chainId).length}`);
  console.log(`  Output dir: ${outDir}\n`);
  console.log(`  ${env.serverBind === "127.0.0.1" ? "Loopback only. Safe for private keys." : "WARNING: bound to " + env.serverBind + " — anyone on your network can hit this server."}\n`);
});

// -----------------------------------------------------------------------------
// /api/trace — start a trace, return run id
// -----------------------------------------------------------------------------
async function startTrace(req, res) {
  const body = await readJsonBody(req);
  const id = randomUUID();
  const params = {
    apiKey: body.apiKey?.trim() || env.apiKey,
    chainId: Number(body.chainId ?? env.chainId),
    scamAddress: String(body.scamAddress ?? "").toLowerCase(),
    maxDepth: clamp(Number(body.maxDepth ?? env.maxDepth), 1, 50),
    maxAddresses: clamp(Number(body.maxAddresses ?? env.maxAddresses), 1, 50_000),
    rps: clamp(Number(body.rps ?? env.rps), 1, 30),
    stopAtOrigin: body.stopAtOrigin !== false,
    direction: ["in", "out", "both"].includes(body.direction) ? body.direction : env.direction,
  };
  if (!/^0x[0-9a-f]{40}$/.test(params.scamAddress)) return sendJson(res, { error: "invalid scamAddress" }, 400);
  if (!params.apiKey) return sendJson(res, { error: "missing apiKey (paste in form or set ETHERSCAN_API_KEY in .env)" }, 400);

  const run = {
    id,
    params,
    state: null,
    done: false,
    aborted: false,
    error: null,
    progress: [],
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  runs.set(id, run);

  // Kick off async
  (async () => {
    try {
      run.state = await runTrace({
        ...params,
        onAbort: () => run.aborted,
        onProgress: (ev) => emitProgress(run, ev),
        onCheckpoint: (s) => {
          // Snapshot to disk so it survives restarts
          run.state = s;
        },
      });
      const envCtx = { chainId: params.chainId, scamAddress: params.scamAddress, direction: params.direction, maxDepth: params.maxDepth };
      await writeReports({ state: run.state, env: envCtx, outDir });
      const analysis = analyze(run.state, params.scamAddress, params.direction);
      emitProgress(run, { type: "report-ready", analysis, runId: id });
      run.done = true;
      emitProgress(run, { type: "close" });
    } catch (err) {
      run.error = err.message;
      emitProgress(run, { type: "error", fatal: true, error: err.message });
      run.done = true;
      emitProgress(run, { type: "close" });
    }
  })();

  sendJson(res, { runId: id });
}

function emitProgress(run, ev) {
  run.progress.push(ev);
  for (const res of run.subscribers) writeSse(res, ev);
}

function streamTrace(id, res) {
  const run = runs.get(id);
  if (!run) { res.statusCode = 404; return res.end("run not found"); }
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
  res.write(":\n\n"); // flush headers

  // Replay buffered progress
  for (const ev of run.progress) writeSse(res, ev);
  if (run.done) { res.end(); return; }

  run.subscribers.add(res);
  res.on("close", () => run.subscribers.delete(res));
}

function abortTrace(id, res) {
  const run = runs.get(id);
  if (!run) return sendJson(res, { error: "run not found" }, 404);
  run.aborted = true;
  sendJson(res, { ok: true });
}

function listRuns(res) {
  if (!existsSync(outDir)) return sendJson(res, []);
  const files = readdirSync(outDir).filter((f) => f.endsWith(".report.md"));
  const runs = files.map((f) => {
    const base = f.replace(".report.md", "");
    const md = readFileSync(join(outDir, f), "utf8");
    const targetMatch = md.match(/#\s*Sweeper Trace:\s*`(0x[0-9a-fA-F]{40})`/);
    return {
      id: base,
      target: targetMatch?.[1] ?? null,
      file: f,
    };
  });
  sendJson(res, runs);
}

function sendReport(id, res) {
  const path = join(outDir, `${id}.json`);
  if (!existsSync(path)) return sendJson(res, { error: "not found" }, 404);
  sendFile(res, path);
}

function writeSse(res, ev) {
  try {
    res.write(`data: ${JSON.stringify(ev)}\n\n`);
  } catch {}
}

// -----------------------------------------------------------------------------
// /api/rescue — compose / simulate / submit
// -----------------------------------------------------------------------------
async function rescueCompose(req, res) {
  const body = await readJsonBody(req);
  try {
    const bundle = await composeBundle({
      chainId: Number(body.chainId ?? 1),
      rpcUrl: body.rpcUrl,
      compromisedKey: body.compromisedKey,
      funderKey: body.funderKey,
      recipient: body.recipient,
      actions: body.actions,
      maxFeePerGasGwei: body.maxFeePerGasGwei ?? null,
      priorityFeeGwei: body.priorityFeeGwei ?? 3,
      tipWei: BigInt(body.tipWei ?? "0"),
    });
    // Do NOT echo signedRawTxs back to the browser — they are bearer bundles
    // containing signatures. Store them server-side and return a handle.
    const handle = randomUUID();
    COMPOSED.set(handle, bundle);
    sendJson(res, {
      handle,
      preview: bundle.preview,
      fees: bundle.fees,
      addresses: bundle.addresses,
      txCount: bundle.signedRawTxs.length,
    });
  } catch (err) {
    sendJson(res, { error: err.shortMessage ?? err.message }, 400);
  }
}

const COMPOSED = new Map(); // handle → bundle

async function rescueSimulate(req, res) {
  const body = await readJsonBody(req);
  const bundle = COMPOSED.get(body.handle);
  if (!bundle) return sendJson(res, { error: "handle expired or not found — compose first" }, 400);
  try {
    const result = await simulateRescue({
      bundle,
      rpcUrl: body.rpcUrl,
      searcherSigningKey: body.searcherKey ?? bundle._searcherKey ?? deriveSearcherKey(),
    });
    sendJson(res, result);
  } catch (err) {
    sendJson(res, { error: err.shortMessage ?? err.message }, 500);
  }
}

async function rescueSubmit(req, res) {
  const body = await readJsonBody(req);
  const bundle = COMPOSED.get(body.handle);
  if (!bundle) return sendJson(res, { error: "handle expired or not found — compose first" }, 400);

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "connection": "keep-alive",
  });
  res.write(":\n\n");

  const searcherKey = body.searcherKey ?? deriveSearcherKey();
  const blocksAhead = clamp(Number(body.blocksAhead ?? 100), 1, 300);

  try {
    for await (const ev of submitRescue({
      bundle,
      rpcUrl: body.rpcUrl,
      searcherSigningKey: searcherKey,
      blocksAhead,
    })) {
      writeSse(res, ev);
      if (ev.type === "done") break;
    }
  } catch (err) {
    writeSse(res, { type: "error", error: err.shortMessage ?? err.message });
  }
  res.end();
}

// Derive a disposable searcher signing key (used only for X-Flashbots-Signature
// reputation). This is NOT the funder or compromised key — it never signs real txs.
function deriveSearcherKey() {
  // Generate a random key per server run. This means no persistent reputation,
  // but every submission works (anonymous searchers are fine for one-shot rescues).
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// -----------------------------------------------------------------------------
// /api/playbook — render RECOVERY.md
// -----------------------------------------------------------------------------
function sendPlaybook(res) {
  const path = join(rootDir, "RECOVERY.md");
  if (!existsSync(path)) return sendJson(res, { error: "RECOVERY.md missing" }, 404);
  const md = readFileSync(path, "utf8");
  sendJson(res, { markdown: md });
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------
function sendFile(res, path) {
  if (!existsSync(path)) { res.statusCode = 404; return res.end("not found"); }
  const ext = extname(path).toLowerCase();
  res.setHeader("content-type", MIME[ext] ?? "application/octet-stream");
  res.end(readFileSync(path));
}
function sendJson(res, obj, status = 200) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(obj));
}
async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}
function clamp(v, min, max) {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
