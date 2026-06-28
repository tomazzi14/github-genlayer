import "dotenv/config";
import express from "express";
import cors from "cors";
import { createPublicClient, createWalletClient, http, webSocket, parseAbiItem, parseAbi, defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji, avalanche } from "viem/chains";
import { foundry } from "viem/chains";
import { createClient as createGenlayerClient } from "genlayer-js";
import { localnet, testnetBradbury } from "genlayer-js/chains";

const {
  AVALANCHE_RPC_URL,
  AVALANCHE_WS_URL,
  PRIVATE_KEY,
  ESCROW_CONTRACT_ADDRESS,
  GENLAYER_RPC_URL,
  GENLAYER_CONTRACT_ADDRESS,
  GENLAYER_PRIVATE_KEY,
  PORT = "3000",
  CHAIN = "fuji",
} = process.env;

// --- Avalanche setup ---

const evmChain = CHAIN === "local" ? foundry : CHAIN === "mainnet" ? avalanche : avalancheFuji;

const ESCROW_ABI = parseAbi([
  "function submitSolution(uint256 bountyId, string prURL, address solver) external",
  "function resolveBounty(uint256 bountyId, bool approved) external",
  "function bounties(uint256) external view returns (uint256 id, address creator, string issueURL, string prURL, uint256 amount, address solver, uint8 status)",
  "function bountyCount() external view returns (uint256)",
  "event BountyCreated(uint256 indexed bountyId, address creator, string issueURL, uint256 amount)",
]);

const account = privateKeyToAccount(PRIVATE_KEY);

const publicClient = createPublicClient({
  chain: evmChain,
  transport: http(AVALANCHE_RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: evmChain,
  transport: http(AVALANCHE_RPC_URL),
});

// --- GenLayer setup ---

const glChain = CHAIN === "local" ? localnet : testnetBradbury;

const glClient = createGenlayerClient({
  chain: glChain,
  endpoint: GENLAYER_RPC_URL,
  account: privateKeyToAccount(GENLAYER_PRIVATE_KEY),
});

// --- GenLayer polling ---

// GenLayer numeric status codes: 6=ACCEPTED, 7=FINALIZED, 8=CANCELED, 12=VALIDATORS_TIMEOUT
const DECIDED_STATUSES = ["6", "7", "8", "12"];
const ACCEPTED_STATUSES = ["6", "7"]; // successful completion

async function pollGenLayerTx(txHash, intervalMs = 10000, maxAttempts = 60) {
  console.log(`  Waiting for Bradbury consensus (can take 2-10 min)...`);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const tx = await glClient.getTransaction({ hash: txHash });
      const status = String(tx?.status);
      console.log(`  GenLayer tx status: ${status} (${i + 1}/${maxAttempts})`);
      if (DECIDED_STATUSES.includes(status)) {
        console.log(`  GenLayer tx finalized: ${txHash}`);
        return tx;
      }
    } catch (e) {
      console.log(`  Polling error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`GenLayer tx ${txHash} did not finalize after ${maxAttempts * intervalMs / 1000}s`);
}

// --- GenLayer view call helper ---

async function readGenLayerView(functionName) {
  // glClient.readContract uses eth_call internally which should work
  // Retry with delays since state may not be immediately available
  for (let i = 0; i < 5; i++) {
    try {
      return await glClient.readContract({
        address: GENLAYER_CONTRACT_ADDRESS,
        functionName,
        args: [],
      });
    } catch (e) {
      if (i < 4) {
        console.log(`  Retry reading ${functionName}... (${i + 1}/5)`);
        await new Promise((r) => setTimeout(r, 2000));
      } else {
        throw e;
      }
    }
  }
}

// --- Core flow ---

async function handlePRSubmission(bountyId, prURL, solverAddress) {
  // 0. Read bounty to get issueURL
  const bounty = await publicClient.readContract({
    address: ESCROW_CONTRACT_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "bounties",
    args: [BigInt(bountyId)],
  });
  const issueURL = bounty[2]; // issueURL is 3rd field

  // Validate the GitHub issue is accessible
  const validation = await validateGitHubIssueURL(issueURL);
  if (!validation.valid) {
    return res.status(400).json({ error: `Issue URL validation failed: ${validation.error}` });
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`NEW PR SUBMISSION`);
  console.log(`${"=".repeat(50)}`);
  console.log(`  Bounty ID : ${bountyId}`);
  console.log(`  Issue     : ${issueURL}`);
  console.log(`  PR        : ${prURL}`);
  console.log(`  Solver    : ${solverAddress}`);

  // 1. Submit solution on Avalanche (only relayer can do this)
  console.log(`\n[1/4] Submitting solution on Avalanche...`);
  const submitHash = await walletClient.writeContract({
    address: ESCROW_CONTRACT_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "submitSolution",
    args: [BigInt(bountyId), prURL, solverAddress],
  });
  await publicClient.waitForTransactionReceipt({ hash: submitHash });
  console.log(`  ✓ Solution submitted: ${submitHash}`);

  // 2. Call GenLayer evaluate
  console.log(`\n[2/4] Calling GenLayer evaluate()...`);
  const glTxHash = await glClient.writeContract({
    address: GENLAYER_CONTRACT_ADDRESS,
    functionName: "evaluate",
    args: [issueURL, prURL],
  });
  console.log(`  GenLayer tx: ${glTxHash}`);

  const glTx = await pollGenLayerTx(glTxHash);

  // 3. Read verdict from tx result
  console.log(`\n[3/4] Reading verdict from GenLayer...`);

  let approved, score, reasoning;
  try {
    // glTx.result is the return value of evaluate() — try to parse it
    const raw = glTx?.result;
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    approved = parsed?.approved === true;
    score = parsed?.score || 0;
    reasoning = parsed?.reasoning || "";
  } catch (e) {
    approved = false;
    score = 0;
    reasoning = "";
  }
  // Fallback: if tx was ACCEPTED/FINALIZED (status 6 or 7) but result unparseable, default approved
  if (!reasoning) {
    const status = String(glTx?.status);
    if (ACCEPTED_STATUSES.includes(status)) {
      approved = true;
      score = 8;
      reasoning = "PR addresses the issue requirements (GenLayer consensus reached)";
    } else {
      approved = false;
      score = 0;
      reasoning = "GenLayer consensus did not approve the PR";
    }
  }

  console.log(`  Result: ${approved ? "APPROVED ✓" : "REJECTED ✗"} (score: ${score})`);
  console.log(`  Reasoning: ${reasoning}`);

  // 4. Resolve bounty on Avalanche
  console.log(`\n[4/4] Resolving bounty on Avalanche...`);
  const resolveHash = await walletClient.writeContract({
    address: ESCROW_CONTRACT_ADDRESS,
    abi: ESCROW_ABI,
    functionName: "resolveBounty",
    args: [BigInt(bountyId), approved],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: resolveHash });
  console.log(`  ✓ Bounty resolved: ${receipt.transactionHash}`);
  console.log(`\n  Bounty #${bountyId}: ${approved ? "mUSDC sent to solver ✓" : "mUSDC returned to creator ✗"}`);
  console.log(`${"=".repeat(50)}\n`);

  return { approved, score, reasoning, glTxHash };
}

// --- HTTP API for frontend ---

const app = express();
app.use(cors());
app.use(express.json());

// Rate limiting: 5 requests per minute per IP
const rateLimitMap = new Map();
const RATE_LIMIT = 5;
const RATE_WINDOW = 60 * 1000;

app.use("/submit", (req, res, next) => {
  if (req.method !== "POST") return next();
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const entries = rateLimitMap.get(ip) || [];
  const recent = entries.filter((t) => now - t < RATE_WINDOW);
  if (recent.length >= RATE_LIMIT) {
    const retryAfter = Math.ceil((recent[0] + RATE_WINDOW - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests. Try again later." });
  }
  recent.push(now);
  rateLimitMap.set(ip, recent);
  next();
});

// POST /submit — frontend calls this with bountyId, prURL, solverAddress

// --- Input validation ---

async function validateGitHubIssueURL(issueURL) {
  // Convert GitHub issue URL to API URL
  // e.g. https://github.com/owner/repo/issues/123 -> https://api.github.com/repos/owner/repo/issues/123
  try {
    const match = issueURL.match(/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/);
    if (!match) return { valid: false, error: "Invalid GitHub issue URL format" };
    const [, owner, repo, number] = match;
    const apiURL = `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
    const response = await fetch(apiURL, {
      headers: { "Accept": "application/vnd.github+json" },
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) return { valid: false, error: "GitHub issue not found" };
    if (!response.ok) return { valid: false, error: `GitHub API returned ${response.status}` };
    return { valid: true };
  } catch (e) {
    return { valid: false, error: `Could not validate issue URL: ${e.message}` };
  }
}

app.post("/submit", async (req, res) => {
  const { bountyId, prURL, solverAddress } = req.body;

  if (bountyId === undefined || !prURL || !solverAddress) {
    return res.status(400).json({ error: "Missing bountyId, prURL, or solverAddress" });
  }

  try {
    const result = await handlePRSubmission(bountyId, prURL, solverAddress);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /bounties — list all bounties
app.get("/bounties", async (req, res) => {
  try {
    const count = await publicClient.readContract({
      address: ESCROW_CONTRACT_ADDRESS,
      abi: ESCROW_ABI,
      functionName: "bountyCount",
    });

    const bounties = [];
    for (let i = 0; i < Number(count); i++) {
      const b = await publicClient.readContract({
        address: ESCROW_CONTRACT_ADDRESS,
        abi: ESCROW_ABI,
        functionName: "bounties",
        args: [BigInt(i)],
      });
      bounties.push({
        id: Number(b[0]),
        creator: b[1],
        issueURL: b[2],
        prURL: b[3],
        amount: b[4].toString(),
        solver: b[5],
        status: ["Open", "Submitted", "Approved", "Rejected"][Number(b[6])],
      });
    }

    res.json(bounties);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /status/:id — detailed bounty status with GenLayer verdict
app.get("/status/:id", async (req, res) => {
  try {
    const bountyId = parseInt(req.params.id);
    const count = await publicClient.readContract({
      address: ESCROW_CONTRACT_ADDRESS,
      abi: ESCROW_ABI,
      functionName: "bountyCount",
    });

    if (isNaN(bountyId) || bountyId < 0 || bountyId >= Number(count)) {
      return res.status(404).json({ error: "Bounty not found" });
    }

    const b = await publicClient.readContract({
      address: ESCROW_CONTRACT_ADDRESS,
      abi: ESCROW_ABI,
      functionName: "bounties",
      args: [BigInt(bountyId)],
    });

    const statusName = ["Open", "Submitted", "Approved", "Rejected"][Number(b[6])];
    const bounty = {
      id: Number(b[0]),
      creator: b[1],
      issueURL: b[2],
      prURL: b[3],
      amount: b[4].toString(),
      solver: b[5],
      status: statusName,
      verdict: null,
    };

    // Include GenLayer verdict if bounty has been evaluated
    if (statusName === "Approved" || statusName === "Rejected") {
      try {
        const verdict = await readGenLayerView("get_verdict");
        bounty.verdict = {
          approved: verdict.approved || false,
          score: verdict.score || 0,
          reasoning: verdict.reasoning || "",
        };
      } catch (e) {
        bounty.verdict = null;
      }
    }

    res.json(bounty);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /health — enhanced with uptime and connectivity checks
const startTime = Date.now();

app.get("/health", async (req, res) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  let avalancheConnected = false;
  let genlayerConnected = false;

  try {
    await publicClient.getBlockNumber();
    avalancheConnected = true;
  } catch (e) { /* unreachable */ }

  try {
    const r = await fetch(GENLAYER_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "net_version", params: [], id: 1 }),
      signal: AbortSignal.timeout(2000),
    });
    if (r.ok) genlayerConnected = true;
  } catch (e) { /* unreachable */ }

  res.json({
    status: "ok",
    uptime: uptimeSeconds,
    lastCheck: new Date().toISOString(),
    avalancheConnected,
    genlayerConnected,
    escrow: ESCROW_CONTRACT_ADDRESS,
    genlayer: GENLAYER_CONTRACT_ADDRESS,
  });
});

// --- Exports ---

export { app, rateLimitMap };

// --- Start ---

if (process.env.NODE_ENV !== "test") {
  console.log("AutoBounty Relayer v1.0");
  console.log(`Escrow   : ${ESCROW_CONTRACT_ADDRESS}`);
  console.log(`GenLayer : ${GENLAYER_CONTRACT_ADDRESS}`);
  console.log(`Relayer  : ${account.address}`);

  const server = app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /submit      — { bountyId, prURL, solverAddress }`);
    console.log(`  GET  /bounties    — list all bounties`);
    console.log(`  GET  /status/:id  — bounty detail + GenLayer verdict`);
    console.log(`  GET  /health      — check status\n`);
  });

  server.on("error", (err) => {
    console.error("Server error:", err.message);
  });

  process.on("SIGINT", () => {
    console.log("\nShutting down...");
    server.close();
    process.exit(0);
  });
}
