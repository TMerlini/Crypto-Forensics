# Sweeper Forensics & Rescue

A self-contained toolkit for two closely-related problems:

1. **Forensics** — you got hacked. Trace where the money went, who the victims are, and what CEX the attacker used.
2. **Rescue** — a compromised wallet still has assets on it that a sweeper bot is watching. Build an atomic Flashbots bundle that funds gas from a burner and sweeps to a clean wallet in the same block, bypassing the public mempool entirely.

Runs as a CLI or as a local web UI. Viem under the hood, zero other runtime dependencies.

```
forensics/
├── src/
│   ├── tracer.mjs       # forensic BFS tracer (importable)
│   ├── trace.mjs        # CLI entry for tracer
│   ├── report.mjs       # JSON/CSV/Markdown writers + analyzer
│   ├── etherscan.mjs    # Etherscan V2 client
│   ├── labels.mjs       # known-origin lookup
│   ├── rescue.mjs       # bundle composer + submitter
│   ├── builders.mjs     # multi-builder submission layer
│   ├── server.mjs       # local HTTP + SSE server
│   └── env.mjs          # .env loader
├── web/                 # single-page UI (vanilla HTML/CSS/JS)
├── labels.json          # 100+ known CEX / bridge / mixer addresses
├── RECOVERY.md          # field guide for rescuing compromised wallets
├── .env.example
└── out/                 # generated reports (gitignored)
```

---

## Quick start (web UI)

```bash
cd forensics
npm install            # pulls viem
cp .env.example .env   # paste your Etherscan key
npm run ui             # → http://127.0.0.1:4337
```

The UI has four tabs:

- **Trace** — enter an address, start a crawl, watch live progress, see the report inline
- **Rescue** — build and submit a Flashbots bundle (compose → simulate → ship)
- **History** — past traces on disk
- **Playbook** — the `RECOVERY.md` guide, rendered inline

Everything binds to `127.0.0.1` by default — private keys entered in the Rescue tab stay on your machine.

## Quick start (CLI)

If you'd rather run traces headless:

```bash
cd forensics
npm install
cp .env.example .env   # pre-filled with 0x541b...ef2f, depth 5, direction "both"
npm run trace
```

Outputs land in `forensics/out/`:

| File | Purpose |
|---|---|
| `trace-<short>-<dir>.report.md` | Human-readable summary (read first) |
| `trace-<short>-<dir>.json` | Full graph + analysis |
| `trace-<short>-<dir>.inflows-to-target.csv` | File with exchanges / IC3 / police |
| `trace-<short>-<dir>.outflows-from-target.csv` | Where the money went |
| `trace-<short>-<dir>.edges.csv` / `.nodes.csv` | Full graph as spreadsheet-friendly CSVs |
| `trace-<short>-<dir>.checkpoint.json` | Resume state. Re-run to continue, delete to restart. |

---

## What the tracer does

Starting from a target address, BFS-walks the funding graph backwards (or cash-out graph forwards, or both):

1. For each address: fetch every incoming/outgoing native ETH, internal ETH, ERC-20, ERC-721, and ERC-1155 transfer from Etherscan, paginated past the 10k-row cap.
2. Record each sender/recipient as a new node, each transfer as an edge.
3. If an address is a known CEX / bridge / mixer — or just any contract — mark it terminal and stop recursing. Otherwise, Binance's hot wallet would pull millions of unrelated users into the graph.
4. Repeat until depth limit or address cap is reached.

The analyzer then computes:

- **Total received** per asset — for a sweeper, this is stolen-funds total
- **Total sent** per asset — cash-out volumes
- **Likely-victim inflows** (excluding known CEX senders) — what the attacker drained from users
- **Gas-seed trail** — the recursive backward chain from the *first* inflow (almost always the attacker's seed tx)
- **Cash-out trail** — the recursive forward chain from the *biggest* outflow (where the money went)
- **Cash-out endpoints** — CEX/bridge/mixer addresses the attacker deposited into, with totals by asset
- **Top ETH funders / recipients** — ranked address lists

---

## What the rescue tool does

The threat model is "attacker has your private key but not the rest of your crypto setup." A sweeper bot monitors compromised wallets and front-runs any incoming gas to instantly drain it — so the usual "just send ETH and move your tokens" approach cannot work.

The tool builds an **atomic Flashbots bundle**:

1. **Funder tx** — a fresh burner sends exactly the gas budget to the compromised wallet
2. **Asset txs** — the compromised wallet transfers each asset (ETH, ERC-20, ERC-721, ERC-1155, or arbitrary contract calls) to a brand new recipient

Because the bundle is submitted via **private orderflow** (POSTed directly to block builders), the sweeper bot never sees the gas arrive in the public mempool. Both transactions are included together or neither is included.

### Submission coverage

The bundle is submitted to all major Ethereum builders in parallel, across N blocks (default 100):

| Builder | Role |
|---|---|
| Flashbots Relay | ~30–40% share |
| beaverbuild | ~30–40% share |
| Titan Builder | ~15–25% share |
| rsync-builder, builder0x69, BuilderNet, Payload, Loki | combined few % |

Combined coverage ~95% of mainnet blocks. Inclusion from any one builder is sufficient.

### Supported action types

- **Send all ETH** — drains remaining ETH balance (minus gas budget) to recipient
- **ERC-20 transfer** — by contract + amount, or "max" for full balance
- **ERC-721 transfer** — by contract + tokenId (works for ENS: see `RECOVERY.md` for contract addresses)
- **ERC-1155 transfer** — by contract + tokenId + amount
- **Custom call** — arbitrary `to` + calldata + value, for anything else (multi-step ENS resolver updates, contract withdrawals, etc.)

### Safety

Every rescue has three buttons:

1. **Compose** — builds and signs the bundle locally, shows you exactly what it will do. Nothing leaves your machine yet.
2. **Simulate** — runs the bundle against the live chain state via Flashbots `eth_callBundle`. Free. Tells you if any tx would revert before you pay gas.
3. **Submit** — actually ships to builders. This is where real value moves.

The server binds to `127.0.0.1` and keys are never logged or sent anywhere except to your RPC URL and builder endpoints.

See `RECOVERY.md` (also rendered as the Playbook tab) for the full field guide.

---

## Known-origin labels

`labels.json` ships with ~100 hand-curated CEX / bridge / mixer addresses across Binance, Coinbase, Kraken, OKX, Bybit, KuCoin, Bitfinex, Gate.io, Crypto.com, Gemini, MEXC, and the major bridges + Tornado Cash / Railgun. Expand as needed — community lists at:

- https://github.com/etherscan-labels
- https://github.com/brianleect/etherscan-labels

---

## Limitations

- **USD valuation** is deliberately absent. Historical per-block prices need another data source and current-price estimates are misleading when the trace spans months.
- **Labels are a static list**. If the gas-seed trail ends at an unlabelled wallet that behaves like a CEX (high tx count, many small withdrawals), add it to `labels.json` and re-run.
- **Mixer trails dead-end by design**. If the attacker funded the bot via Tornado Cash, on-chain forensics won't reach further without external chainalysis data.
- **Single chain per run**. Set `CHAIN_ID` in `.env` or pick from the UI dropdown.
- **Rescue assumes single compromised EOA**. Multi-sig recovery, smart wallet recovery (Safe modules), and social-recovery wallets need different strategies not covered here.

---

## If you've been hacked — sequence

1. **Stop using the compromised device.** Move to a clean one.
2. **If the wallet still has value**: run the Rescue tab. Do not manually send anything — you will lose the race.
3. **Trace the attacker**: run the Trace tab. Attach the report + CSVs to every exchange / police report.
4. **Identify the leak vector.** Most common: seed stored in cloud, malicious extension, clipboard malware, bad permit signature, phishing. If you can't identify it, a new wallet on the same device will get drained too.
5. **Rotate everything crypto-adjacent**: seed phrases (new hardware wallet, new seed generated offline), exchange API keys, email passwords + MFA, anything else.

---

## License

MIT — see [LICENSE](./LICENSE). Use it, fork it, help someone else not get rekt. No warranty; you are responsible for what you sign.
