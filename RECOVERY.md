# Recovery Playbook: Rescuing Assets from a Wallet with a Sweeper

Field notes from a real rescue. Applies when an attacker has your private key and runs a sweeper bot that drains any ETH arriving at the address the moment it lands.

## The problem

A sweeper bot watches one or more wallets whose keys it controls. The bot is cheap to run:

- Subscribes to pending-tx mempool + new blocks
- When any ETH balance appears on a watched wallet, it immediately broadcasts a sweep tx with a gas price slightly higher than what you'd normally pay, landing in the next block before you can move anything out

Your password, 2FA, device, and browser are irrelevant — the attacker has the raw private key. Rotating anything other than the key itself does nothing. You cannot "log out" of a compromised key.

Any attempt to manually fund gas and then send a transfer will lose the race against the sweeper ~100% of the time, because:

1. You send gas → it hits public mempool
2. Sweeper sees new balance in mempool — instantly fires sweep tx with higher tip
3. Block is produced, sweep tx lands first, your gas is gone to the attacker, your transfer reverts for lack of gas

## The solution: private orderflow + atomic bundles

Two txs bundled atomically and delivered to block builders via **private orderflow** (not public mempool):

1. **Funder tx** — a fresh burner wallet sends gas to the compromised wallet
2. **Sweep tx(s)** — the compromised wallet transfers assets to a brand new clean wallet

Because the bundle bypasses the public mempool entirely, the sweeper bot never sees the gas arrive until it's already on-chain — by which point the asset transfer has also landed in the same block. Both txs are included together or neither is included; the bundle is atomic.

## Prerequisites

Before you do anything on-chain:

- [ ] **Brand new device** if possible. A phone hotspot or clean laptop. Assume any machine where the seed was ever typed or stored is compromised.
- [ ] **Three fresh wallets**, all generated offline on the clean device:
  - Burner-funder — holds ~0.01–0.05 ETH for gas
  - Clean recipient — receives the rescued assets (give it a memorable name, this is your new main)
  - Searcher signing key — optional, any random key for Flashbots reputation header
- [ ] **RPC URL** with balance/gas/nonce access. Infura, Alchemy, Chainstack, your own node. Anything non-rate-limited.
- [ ] **The compromised private key** in raw `0x…64-hex` form. Export it from Metamask's "Account details → Show private key" on the trusted machine where you still have it.

Do **not** use any of your existing wallets for the burner or recipient. The attacker may be watching patterns.

## Which builders to submit to

Block builder market share matters because the bundle only lands if the builder that wins a given slot has our bundle to include. Submit to all of these in parallel, for every target block:

| Builder | URL | Signed header | Approx. share |
|---|---|---|---|
| Flashbots Relay | `relay.flashbots.net` | yes | ~30–40% |
| beaverbuild | `rpc.beaverbuild.org` | no | ~30–40% |
| Titan Builder | `rpc.titanbuilder.xyz` | yes | ~15–25% |
| rsync-builder | `rsync-builder.xyz` | no | few % |
| builder0x69 | `builder0x69.io` | no | few % |
| BuilderNet | `buildernet.org` | yes | few % |

Combined, these five cover ~95% of mainnet blocks. Inclusion from any one is sufficient — whichever builder wins the auction for the slot that includes our bundle writes it to that block, and our txs land on-chain exactly once.

The **signed header** is the `X-Flashbots-Signature` — a signature over the request body with any Ethereum key, used for searcher reputation (not for authorising the bundle). It's just a rate-limit/reputation signal. The first bundle you submit from a given searcher key gets treated as a new searcher and may be deprioritised — that's why multi-builder submission is essential.

## Mechanics: building the bundle

### 1. Compute gas budget

For each action you want to execute from the compromised wallet, estimate gas:

```js
const gas = await publicClient.estimateGas({
  account: compromisedAddr,
  to, data, value,
});
```

Add a 20% safety buffer. Sum all `gas * maxFeePerGas` — that's the exact wei the funder needs to send.

Use aggressive fee settings for rescue bundles:

- `priorityFee = 2–5 gwei` (higher than typical, to win the builder's internal auction)
- `maxFeePerGas = 3× basefee + priorityFee` — gives you headroom if basefee spikes

### 2. Sign each tx

- Funder tx: EIP-1559, `nonce = funder.getTransactionCount("pending")`, `to = compromised`, `value = gasBudget`, `gas = 21000`, `data = 0x`.
- Compromised txs: each at `nonce = compromised.getTransactionCount("pending") + i`, with the action's encoded calldata.

### 3. Assemble bundle

```json
{
  "jsonrpc": "2.0", "id": 1,
  "method": "eth_sendBundle",
  "params": [{
    "txs": ["0x<funder raw>", "0x<compromised raw 1>", "0x<compromised raw 2>"],
    "blockNumber": "0x<target block hex>",
    "minTimestamp": 0, "maxTimestamp": 0,
    "revertingTxHashes": []
  }]
}
```

Submit this to every builder in the list, for every block from `latest + 1` up to `latest + 100`. That's ~100 × 6 = 600 submissions. Do them in parallel.

### 4. Watch for inclusion

Poll `eth_getTransactionReceipt(funderTxHash)` every 2 seconds. The moment it returns a receipt, the bundle has been included.

### 5. Verify and rotate

After inclusion:

- `eth_getBalance(compromised)` should be near zero
- All target NFTs should now be owned by the recipient
- If any action silently failed, **do not** retry the same bundle — re-build with updated nonces (the compromised wallet's nonce has advanced)

## ENS-specific notes

ENS names have multiple moving parts. Full recovery means transferring all of them:

| Thing | Contract | Method |
|---|---|---|
| `.eth` 2LD registrant (unwrapped) | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` BaseRegistrar | `safeTransferFrom(compromised, recipient, tokenId)` |
| Wrapped name (NameWrapper) | `0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401` | `safeTransferFrom(compromised, recipient, tokenId, 1, "0x")` |
| Controller (owner of the node in Registry) | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` ENSRegistry | `setOwner(node, recipient)` |
| Resolver records | current PublicResolver | `setAddr(node, recipient)` etc. |

`tokenId` for a `.eth` name = `uint256(keccak256(label))` where `label` is the name without `.eth` (e.g. for `vitalik.eth`, label = `"vitalik"`).

For most rescues, transferring the registrant NFT (first row) is sufficient — the new owner can re-claim controller + set resolver records at leisure from the clean wallet. If the name is wrapped, use the NameWrapper.

If you only have minutes before the attacker moves it, just do the registrant transfer and worry about records later.

## What can go wrong

**Simulation says revert.** One or more actions will fail on-chain. Check: does the compromised wallet actually own the token? (The attacker may have moved it already.) Is the contract paused? Is the recipient address a contract that rejects ERC-721 `onReceived`?

**Bundle never lands.** Builders reject malformed bundles silently. Check: all nonces correct? All txs signed with correct chainId? Bundle simulated cleanly via `eth_callBundle` first? Enough priority fee to compete in-block?

**Bundle lands but later outflow to recipient gets swept somehow.** The sweeper probably also watches your recipient. Generate a new one that has never been on-chain before.

**Attacker also has the burner key.** Possible if the device used to generate it is compromised. Use a separate clean device.

**ENS records not transferred.** Only the registrant NFT moved. This is fine — you now control the name and can re-set resolver/records from the clean wallet. The attacker no longer does.

## Timing pressure

Once you start moving: the attacker may notice on-chain activity and escalate (manually sweep remaining assets, transfer NFTs out, etc.). From decision → submitted bundle should be under 10 minutes. The bundle itself lands in seconds once submitted.

Do **not** do test transactions from the compromised wallet before the real bundle — they'll tip the sweeper off and you'll lose the race on the actual rescue.

## Legal / reporting

Once assets are safe, file:

- **IC3** (https://www.ic3.gov) — US
- **Action Fraud** (https://www.actionfraud.police.uk) — UK
- **Europol EC3** / local cybercrime unit — EU
- **The CEX** at the end of the attacker's gas-seed chain (identified via the forensic tracer) — they may have KYC on the attacker and can flag the account
- **Circle** (`noreply@centre.io` for USDC), **Tether** (`report@tether.to` for USDT) — they can blacklist attacker addresses if stablecoins are involved

Attach the Markdown report and `inflows-to-target.csv` from the tracer to every report. They make a coherent case.

## Don't forget the autopsy

Before moving on: figure out **how** the key leaked. If you don't, the new wallet will get drained too. Common vectors:

- Seed phrase stored in cloud (iCloud notes, Google Drive, Evernote, Google Keep, screenshots in Photos)
- Malicious browser extension masquerading as Metamask or a wallet
- Clipboard hijacker (copied an address, pasted a different one; OR the malware monitored clipboard for 12/24-word seeds)
- Fake airdrop signature that the wallet silently approved as a permit / blanket approval
- Pasted seed into a phishing site imitating a real wallet app
- Trojanised installer of a "crypto" app (fake Ledger Live, fake Trezor Suite, fake staking tool)
- SIM swap enabling iCloud/Google account takeover, then reading backed-up seed
- Third-party wallet sharing a key across devices with an insecure sync protocol

If you can't identify the vector with high confidence, treat *every* device you've ever used for crypto as compromised.
