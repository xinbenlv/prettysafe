#!/usr/bin/env bun
/**
 * CLI vanity EVM address miner — CPU-only variant using ethers.js.
 * Produces identical output format to keyminer.ts but uses sequential
 * CPU key derivation instead of WebGPU.
 *
 * Pipeline: private_key → ethers.Wallet → address → check leading zeros
 *
 * Usage:
 *   bun run keyminer-cpu.ts [--start-key 0x...] [--leading-zeros 8] [--no-resume]
 *
 * WARNING: This tool displays private keys in the terminal.
 *          Anyone with access to a private key controls the corresponding wallet.
 */

import { join } from "path";
import { parseArgs } from "util";
import { Wallet } from "ethers";

// ── CLI args ──────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    "start-key": { type: "string" },
    "leading-zeros": { type: "string" },
    "no-resume": { type: "boolean" },
  },
  strict: true,
  allowPositionals: true,
});

const targetZeros = parseInt(values["leading-zeros"] ?? "8");
const noResume = values["no-resume"] ?? false;

// Default start key: random 16-byte prefix in the upper half, lower 16 bytes = 0.
let startKeyHex: string;
if (values["start-key"]) {
  startKeyHex = values["start-key"];
  if (!startKeyHex.startsWith("0x")) startKeyHex = "0x" + startKeyHex;
} else {
  const randomPrefix = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  startKeyHex = "0x" + randomPrefix + "0".repeat(32);
}

// ── Bignum helpers ────────────────────────────────────────────────────

function bigintToHex64(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function countLeadingZeroHex(address: string): number {
  const clean = address.replace("0x", "").toLowerCase();
  let count = 0;
  for (const c of clean) {
    if (c === "0") count++;
    else break;
  }
  return count;
}

// ── Formatting helpers ────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "---";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds < 86400 * 365) return `${(seconds / 86400).toFixed(1)}d`;
  return `${(seconds / (86400 * 365)).toFixed(1)}y`;
}

function formatHashes(n: number): string {
  if (n < 1e6) return `${(n / 1e3).toFixed(0)}K`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}M`;
  if (n < 1e12) return `${(n / 1e9).toFixed(1)}G`;
  return `${(n / 1e12).toFixed(1)}T`;
}

// ── Output file ───────────────────────────────────────────────────────
const keyPrefix = startKeyHex.replace("0x", "").slice(0, 16);
const outPath = join(import.meta.dir, "tmp", `keyminer-cpu-${keyPrefix}.json`);

interface ResultEntry {
  privateKey: string;
  address: string;
  leadingZeros: number;
  foundAt: string;
  totalKeysAtDiscovery: number;
}

interface OutputFile {
  startKey: string;
  targetZeros: number;
  totalKeys: number;
  lastOffset: number;
  startedAt: string;
  results: ResultEntry[];
}

let output: OutputFile;
let resumedKeys = 0;
let resumedOffset = 0;

if (!noResume) {
  try {
    output = await Bun.file(outPath).json();
    resumedKeys = output.totalKeys ?? 0;
    resumedOffset = output.lastOffset ?? 0;
    console.log(`Resuming from ${outPath}`);
    console.log(
      `  ${output.results.length} prior results, ${formatHashes(resumedKeys)} keys tested, offset=${resumedOffset}`
    );
    if (output.results.length > 0) {
      console.log(`\n  Past results:`);
      for (const r of output.results) {
        console.log(
          `    ${r.address} (${r.leadingZeros}z) key=${r.privateKey}`
        );
      }
      console.log();
    }
  } catch {
    output = null as any;
  }
}
if (!output) {
  output = {
    startKey: startKeyHex,
    targetZeros: targetZeros,
    totalKeys: 0,
    lastOffset: 0,
    startedAt: new Date().toISOString(),
    results: [],
  };
}

async function saveResults(currentTotalKeys: number, currentOffset: number) {
  output.totalKeys = resumedKeys + currentTotalKeys;
  output.lastOffset = currentOffset;
  await Bun.write(outPath, JSON.stringify(output, null, 2) + "\n");
}

// ── Probability math ──────────────────────────────────────────────────
const LN10 = Math.log(10);

function hashesForNZeros(n: number): number {
  return LN10 * Math.pow(16, n);
}

function expectedHashesForNZeros(n: number): number {
  return Math.pow(16, n);
}

// ── CPU mining function ───────────────────────────────────────────────
const BATCH_SIZE = 1000;

interface BatchResult {
  bestAddress: string | null;
  bestKey: string | null;
  bestZeros: number;
}

function mineBatch(startScalar: bigint, count: number): BatchResult {
  let bestAddress: string | null = null;
  let bestKey: string | null = null;
  let bestZeros = 0;

  for (let i = 0; i < count; i++) {
    const scalar = startScalar + BigInt(i);
    const keyHex = bigintToHex64(scalar);
    try {
      const wallet = new Wallet(keyHex);
      const addr = wallet.address.toLowerCase();
      const zeros = countLeadingZeroHex(addr);
      if (zeros > bestZeros || (zeros === bestZeros && bestAddress !== null && addr < bestAddress)) {
        bestZeros = zeros;
        bestAddress = addr;
        bestKey = keyHex;
      }
    } catch {
      // skip invalid keys (e.g. 0 or >= curve order)
    }
  }

  return { bestAddress, bestKey, bestZeros };
}

// ── Start ─────────────────────────────────────────────────────────────
console.log(`\nWARNING: This tool displays private keys in the terminal.`);
console.log(`   Anyone with the private key controls the corresponding wallet.\n`);
console.log(`Mining vanity EVM addresses via private key iteration (CPU)`);
console.log(`  Start key: ${startKeyHex}`);
console.log(`  Target: ${targetZeros} leading zeros`);
console.log(`  Output: ${outPath}`);
console.log();

const startKeyBigInt = BigInt(startKeyHex);

// ── Warmup ────────────────────────────────────────────────────────────
console.log(`Warming up (2s)...`);
let warmupKeys = 0;
const warmupStart = performance.now();
let currentOffset = resumedOffset;

while (performance.now() - warmupStart < 2000) {
  mineBatch(startKeyBigInt + BigInt(currentOffset), BATCH_SIZE);
  currentOffset += BATCH_SIZE;
  warmupKeys += BATCH_SIZE;
}
const warmupElapsed = (performance.now() - warmupStart) / 1000;
const measuredRate = warmupKeys / warmupElapsed;

console.log(`Rate: ${(measuredRate / 1e3).toFixed(1)} K keys/s\n`);

// ── Print expected time table ─────────────────────────────────────────
console.log(
  `  Zeros | Expected Keys   | Expected Time  | 90% Chance Keys   | 90% Chance Time`
);
console.log(
  `  ------+-----------------+----------------+-------------------+----------------`
);
for (let z = 4; z <= 12; z++) {
  const expH = expectedHashesForNZeros(z);
  const expT = expH / measuredRate;
  const h90 = hashesForNZeros(z);
  const t90 = h90 / measuredRate;
  console.log(
    `  ${String(z).padStart(5)} | ${formatHashes(expH).padStart(15)} | ${formatDuration(expT).padStart(14)} | ${formatHashes(h90).padStart(17)} | ${formatDuration(t90).padStart(14)}`
  );
}
console.log();

// ── Mining state ──────────────────────────────────────────────────────
let totalKeys = warmupKeys;
const startTime = performance.now() - warmupElapsed * 1000;

let bestAddress = BigInt("0x" + "f".repeat(40));
if (output.results.length > 0) {
  bestAddress = BigInt(output.results[0].address);
}

let currentBestZeros =
  output.results.length > 0 ? output.results[0].leadingZeros : 0;
let lockedTargetZeros = currentBestZeros + 1;
let keysSinceLock = 0;

// Graceful shutdown
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log(
    "\nStopping after current batch... (Ctrl+C again to force)"
  );
});

console.log(`Mining started. Press Ctrl+C to stop.\n`);

let lastSave = performance.now();
const SAVE_INTERVAL = 10_000; // save every 10s

while (!stopping) {
  const batchStart = startKeyBigInt + BigInt(currentOffset);
  const result = mineBatch(batchStart, BATCH_SIZE);

  if (result.bestAddress && result.bestKey) {
    const addrBigInt = BigInt(result.bestAddress);

    if (addrBigInt < bestAddress) {
      bestAddress = addrBigInt;

      totalKeys = currentOffset - resumedOffset + BATCH_SIZE;
      const entry: ResultEntry = {
        privateKey: result.bestKey,
        address: result.bestAddress,
        leadingZeros: result.bestZeros,
        foundAt: new Date().toISOString(),
        totalKeysAtDiscovery: resumedKeys + totalKeys,
      };

      output.results.push(entry);
      output.results.sort((a, b) => {
        const addrA = BigInt(a.address);
        const addrB = BigInt(b.address);
        if (addrA < addrB) return -1;
        if (addrA > addrB) return 1;
        return 0;
      });

      await saveResults(totalKeys, currentOffset);

      const elapsed = (
        (performance.now() - startTime) /
        1000
      ).toFixed(0);
      console.log(
        `\n  NEW BEST: ${result.bestAddress} (${result.bestZeros} leading zeros, ${elapsed}s)`
      );
      console.log(`  key: ${result.bestKey}`);

      if (result.bestZeros > currentBestZeros) {
        currentBestZeros = result.bestZeros;
        const newTarget = result.bestZeros + 1;
        if (newTarget > lockedTargetZeros) {
          lockedTargetZeros = newTarget;
          keysSinceLock = 0;
        }
      }

      if (result.bestZeros >= targetZeros) {
        console.log(
          `\n  Target of ${targetZeros} leading zeros reached!`
        );
        stopping = true;
      }
    }
  }

  currentOffset += BATCH_SIZE;
  keysSinceLock += BATCH_SIZE;
  totalKeys = currentOffset - resumedOffset;

  const now = performance.now();
  const elapsed = (now - startTime) / 1000;
  const rate = totalKeys / elapsed;

  // Periodic save
  if (now - lastSave > SAVE_INTERVAL) {
    await saveResults(totalKeys, currentOffset);
    lastSave = now;
  }

  const h90 = hashesForNZeros(lockedTargetZeros);
  const remaining90 = Math.max(0, h90 - keysSinceLock);
  const remaining90sec = rate > 0 ? remaining90 / rate : Infinity;
  const p = 1 / Math.pow(16, lockedTargetZeros);
  const probFound = 1 - Math.exp(-keysSinceLock * p);
  const probPercent = Math.min(99.999, probFound * 100);

  process.stdout.write(
    `\r  ${formatDuration(elapsed)} | ${(rate / 1e3).toFixed(1)} K/s | ${formatHashes(totalKeys)} keys | best: ${currentBestZeros}z` +
      ` | ${lockedTargetZeros}z: ${probPercent.toFixed(1)}% ETA: ${formatDuration(remaining90sec)}   `
  );
}

// Final save
await saveResults(totalKeys, currentOffset);
const finalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
console.log(
  `\n\nDone. ${finalElapsed}s, ${output.results.length} results saved to ${outPath}`
);
