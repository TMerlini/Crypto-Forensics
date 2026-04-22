// Bundle composer for rescuing assets from a compromised wallet.
//
// Given:
//   - compromisedKey:  private key of the hacked wallet that holds assets but has
//                      no gas (a sweeper bot front-runs any incoming gas to drain it)
//   - funderKey:       private key of a fresh burner wallet that pays the gas
//   - recipient:       a clean wallet address that receives the rescued assets
//   - actions[]:       list of what to transfer (ETH / ERC-20 / ERC-721 / ERC-1155 / custom)
//
// We build an atomic Flashbots bundle:
//   tx[0]:  funder → compromised: gas funding
//   tx[1..n]: compromised → recipient: asset transfers
//
// The bundle is submitted via private orderflow to multiple builders for N blocks.
// The sweeper bot never sees the gas hit the mempool because the bundle goes
// straight from our submitBundle() call → builder → block, bypassing public mempool
// entirely. If any tx reverts, the whole bundle reverts and nothing is paid.

import { createPublicClient, http, encodeFunctionData, isHex, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet, sepolia } from "viem/chains";
import { buildersForChain, simulateBundle, submitBundleToMany } from "./builders.mjs";

const ERC20_ABI = [
  { name: "transfer", type: "function", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }] },
];

const ERC721_ABI = [
  { name: "safeTransferFrom", type: "function", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "tokenId", type: "uint256" }], outputs: [] },
];

const ERC1155_ABI = [
  { name: "safeTransferFrom", type: "function", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "id", type: "uint256" }, { name: "amount", type: "uint256" }, { name: "data", type: "bytes" }], outputs: [] },
];

// -----------------------------------------------------------------------------
// Build an unsigned tx description for a single action (executed from the
// compromised wallet).
// -----------------------------------------------------------------------------
function buildActionTxRequest(action, compromised, recipient) {
  switch (action.type) {
    case "eth": {
      // Send all available ETH. Actual value gets computed at signing time
      // because we need to subtract the gas cost of THIS tx.
      return { kind: "eth", to: recipient, valuePlaceholder: true };
    }
    case "eth_exact": {
      return { kind: "eth", to: recipient, value: BigInt(action.amount) };
    }
    case "erc20": {
      if (!action.amount) throw new Error("erc20 action requires amount (use 'max' to send full balance)");
      return {
        kind: "call",
        to: action.contract.toLowerCase(),
        data: null,
        encode: async (publicClient) => {
          let amount = action.amount;
          if (amount === "max") {
            amount = await publicClient.readContract({
              address: action.contract,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [compromised],
            });
          } else {
            amount = BigInt(amount);
          }
          return encodeFunctionData({ abi: ERC20_ABI, functionName: "transfer", args: [recipient, amount] });
        },
      };
    }
    case "erc721": {
      return {
        kind: "call",
        to: action.contract.toLowerCase(),
        data: encodeFunctionData({
          abi: ERC721_ABI,
          functionName: "safeTransferFrom",
          args: [compromised, recipient, BigInt(action.tokenId)],
        }),
      };
    }
    case "erc1155": {
      return {
        kind: "call",
        to: action.contract.toLowerCase(),
        data: encodeFunctionData({
          abi: ERC1155_ABI,
          functionName: "safeTransferFrom",
          args: [compromised, recipient, BigInt(action.tokenId), BigInt(action.amount ?? 1), "0x"],
        }),
      };
    }
    case "custom": {
      if (!action.to || !action.data) throw new Error("custom action requires `to` and `data`");
      return { kind: "call", to: action.to.toLowerCase(), data: action.data, value: BigInt(action.value ?? 0) };
    }
    default:
      throw new Error(`unknown action type: ${action.type}`);
  }
}

// -----------------------------------------------------------------------------
// Compose & sign the bundle.
// -----------------------------------------------------------------------------
export async function composeBundle({
  chainId,
  rpcUrl,
  compromisedKey,
  funderKey,
  recipient,
  actions,
  tipWei = 0n,                   // optional coinbase tip appended after last tx
  maxFeePerGasGwei = null,       // override if you want to be aggressive
  priorityFeeGwei = 3,
}) {
  const chain = chainId === 1 ? mainnet : chainId === 11155111 ? sepolia : mainnet;
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain, transport });

  const compromised = privateKeyToAccount(compromisedKey);
  const funder = privateKeyToAccount(funderKey);
  const compromisedAddr = compromised.address;
  const funderAddr = funder.address;
  const recipientAddr = normaliseAddr(recipient);

  if (compromisedAddr.toLowerCase() === funderAddr.toLowerCase()) {
    throw new Error("funder and compromised wallets must be different");
  }

  // Current fee market
  const block = await publicClient.getBlock({ blockTag: "pending" });
  const baseFee = block.baseFeePerGas ?? 0n;
  const priorityFee = BigInt(Math.floor(priorityFeeGwei * 1e9));
  const maxFeePerGas = maxFeePerGasGwei
    ? BigInt(Math.floor(maxFeePerGasGwei * 1e9))
    : baseFee * 3n + priorityFee;   // aggressive — 3x base is standard for rescue bundles

  // Resolve each action into a call request + estimate gas
  const prepared = [];
  for (const action of actions) {
    const req = buildActionTxRequest(action, compromisedAddr, recipientAddr);

    if (req.kind === "eth" && req.valuePlaceholder) {
      // Placeholder — we compute final value after we know total gas budget.
      prepared.push({ ...req, gas: 21_000n });
      continue;
    }
    if (req.kind === "eth") {
      prepared.push({ ...req, gas: 21_000n });
      continue;
    }
    if (req.kind === "call") {
      const data = typeof req.encode === "function" ? await req.encode(publicClient) : req.data;
      let gas;
      try {
        gas = await publicClient.estimateGas({
          account: compromisedAddr,
          to: req.to,
          data,
          value: req.value ?? 0n,
        });
      } catch (err) {
        throw new Error(`gas estimation failed for action ${JSON.stringify(action)}: ${err.shortMessage ?? err.message}`);
      }
      prepared.push({ ...req, data, gas: (gas * 120n) / 100n }); // 20% buffer
    }
  }

  // Compute gas budget the funder needs to send to the compromised wallet.
  // compromisedGasCost = sum(gas * maxFeePerGas) for all compromised-originated txs
  const compromisedGasCost = prepared.reduce((acc, p) => acc + p.gas * maxFeePerGas, 0n);

  // If one of the compromised actions is "send all remaining ETH", we also need
  // to know the balance so we can size it.
  const compromisedBalance = await publicClient.getBalance({ address: compromisedAddr });
  const compromisedTotalValueOut = prepared
    .filter((p) => p.kind === "eth" && !p.valuePlaceholder)
    .reduce((a, p) => a + p.value, 0n);

  // Funding amount = gas budget + optional tip. We do NOT pre-fund ETH transfers
  // from the compromised wallet — those come from its own balance.
  const fundingAmount = compromisedGasCost + tipWei;

  // Build funder gas-seed tx
  const funderNonce = await publicClient.getTransactionCount({ address: funderAddr, blockTag: "pending" });
  const funderTxRequest = {
    chainId,
    type: "eip1559",
    to: compromisedAddr,
    value: fundingAmount,
    data: "0x",
    nonce: funderNonce,
    gas: 21_000n,
    maxFeePerGas,
    maxPriorityFeePerGas: priorityFee,
  };
  const funderSigned = await funder.signTransaction(funderTxRequest);

  // Build each compromised tx
  let compromisedNonce = await publicClient.getTransactionCount({ address: compromisedAddr, blockTag: "pending" });
  const signedTxs = [funderSigned];
  const txPreview = [
    { role: "funder-gas-seed", from: funderAddr, to: compromisedAddr, value: fundingAmount.toString(), gas: "21000" },
  ];

  // We need to know how much ETH the compromised wallet will hold AFTER the
  // funding tx (= compromisedBalance + fundingAmount), and subtract the value
  // of any "send all" placeholder.
  const compromisedPostFundBalance = compromisedBalance + fundingAmount;
  const remainingEthForPlaceholder = compromisedPostFundBalance - compromisedGasCost - compromisedTotalValueOut;

  for (const p of prepared) {
    const nonce = compromisedNonce++;
    let value = p.value ?? 0n;
    if (p.kind === "eth" && p.valuePlaceholder) {
      if (remainingEthForPlaceholder <= 0n) {
        throw new Error("not enough ETH to sweep after gas budget; increase funding or drop the 'send all ETH' action");
      }
      value = remainingEthForPlaceholder;
    }
    const req = {
      chainId,
      type: "eip1559",
      to: p.to,
      value,
      data: p.kind === "eth" ? "0x" : p.data,
      nonce,
      gas: p.gas,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
    };
    const signed = await compromised.signTransaction(req);
    signedTxs.push(signed);
    txPreview.push({
      role: p.kind === "eth" ? "sweep-eth" : `call ${p.to}`,
      from: compromisedAddr,
      to: p.to,
      value: value.toString(),
      gas: p.gas.toString(),
      data: p.kind === "eth" ? "0x" : p.data.slice(0, 12) + "…",
    });
  }

  return {
    chainId,
    signedRawTxs: signedTxs,
    preview: txPreview,
    fees: {
      baseFee: baseFee.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      priorityFee: priorityFee.toString(),
      fundingAmount: fundingAmount.toString(),
      compromisedBalance: compromisedBalance.toString(),
    },
    addresses: { compromised: compromisedAddr, funder: funderAddr, recipient: recipientAddr },
  };
}

function normaliseAddr(a) {
  if (!a || !isHex(a) || a.length !== 42) throw new Error(`invalid address: ${a}`);
  return a.toLowerCase();
}

// -----------------------------------------------------------------------------
// Simulate the bundle (free, via Flashbots eth_callBundle).
// -----------------------------------------------------------------------------
export async function simulateRescue({ bundle, rpcUrl, searcherSigningKey }) {
  const chain = bundle.chainId === 1 ? mainnet : sepolia;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const tipBlock = await publicClient.getBlockNumber();
  return simulateBundle({
    signedRawTxs: bundle.signedRawTxs,
    blockNumber: tipBlock + 1n,
    searcherSigningKey,
  });
}

// -----------------------------------------------------------------------------
// Submit to N builders across M blocks. Yields progress events.
// -----------------------------------------------------------------------------
export async function* submitRescue({
  bundle,
  rpcUrl,
  searcherSigningKey,
  blocksAhead = 100,
  builders = null,
  onAbort = () => false,
}) {
  const chain = bundle.chainId === 1 ? mainnet : sepolia;
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const builderList = builders ?? buildersForChain(bundle.chainId);
  if (!builderList.length) throw new Error(`No builders configured for chain ${bundle.chainId}`);

  const tip = await publicClient.getBlockNumber();
  const fromBlock = tip + 1n;
  const toBlock = tip + BigInt(blocksAhead);

  yield {
    type: "start",
    fromBlock: Number(fromBlock),
    toBlock: Number(toBlock),
    builderCount: builderList.length,
    submissions: builderList.length * blocksAhead,
  };

  // Fire all submissions, stream results. Meanwhile poll chain for the first
  // funder tx to confirm inclusion.
  const funderTxHash = hashOfRawTx(bundle.signedRawTxs[0]);
  let included = false;
  let includedBlock = null;

  const watcher = (async () => {
    while (!included && !onAbort()) {
      try {
        const rc = await publicClient.getTransactionReceipt({ hash: funderTxHash }).catch(() => null);
        if (rc) {
          included = true;
          includedBlock = Number(rc.blockNumber);
          return;
        }
      } catch {}
      await sleep(2000);
    }
  })();

  try {
    for await (const r of submitBundleToMany({
      builders: builderList,
      signedRawTxs: bundle.signedRawTxs,
      fromBlock,
      toBlock,
      searcherSigningKey,
      onAbort: () => onAbort() || included,
    })) {
      yield { type: "submit-result", ...r };
      if (included) break;
    }
  } finally {
    await watcher;
  }

  yield {
    type: "done",
    included,
    includedBlock,
    funderTxHash,
  };
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Tx hash of a raw signed tx = keccak256(raw bytes) for both legacy and EIP-1559.
function hashOfRawTx(raw) {
  return keccak256(raw);
}
