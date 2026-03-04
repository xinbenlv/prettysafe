#!/usr/bin/env bun
/**
 * CLI vanity address miner for Gnosis Safe CREATE2 addresses.
 * Uses WebGPU (via bun-webgpu) to brute-force saltNonces.
 * Each time a new best (smallest) address is found, it's appended
 * to the results and immediately saved to disk.
 *
 * Usage:
 *   bun run mine.ts --owners 0xABC...,0xDEF... [--threshold 1] [--url http://localhost:5173]
 *
 * Options:
 *   --owners      Comma-separated owner addresses (required)
 *   --threshold   Safe multisig threshold (default: 1)
 *   --url         Base URL for deploy links (default: https://prettysafe.xyz)
 *   --no-resume   Start fresh instead of resuming from existing results file
 */

import { join } from "path";
import { parseArgs } from "util";
import { type Address } from "viem";
import {
  prepareShaderData,
  deriveSafeAddress,
  countLeadingZeros,
  type SafeConfig,
} from "./src/lib/safe-encoder";
import {
  PROXY_FACTORY,
  PROXY_CREATION_CODE_HASH,
} from "./src/lib/gnosis-constants";

// ── CLI args ──────────────────────────────────────────────────────────
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    owners: { type: "string" },
    threshold: { type: "string" },
    url: { type: "string" },
    "no-resume": { type: "boolean" },
  },
  strict: true,
  allowPositionals: true,
});

if (!values.owners) {
  console.error("Usage: bun run mine.ts --owners 0xABC...,0xDEF... [--threshold 1] [--url http://localhost:5173] [--no-resume]");
  process.exit(1);
}

const owners = values.owners.split(",").map((a) => a.trim() as Address);
const safeThreshold = BigInt(values.threshold ?? "1");
const baseUrl = values.url ?? "https://prettysafe.xyz";
const noResume = values["no-resume"] ?? false;
const config: SafeConfig = { owners, threshold: safeThreshold };

// ── Formatting helpers ────────────────────────────────────────────────
function formatDuration(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "---";
  if (seconds < 1e-6) return `${(seconds * 1e9).toFixed(1)}ns`;
  if (seconds < 1e-3) return `${(seconds * 1e6).toFixed(1)}µs`;
  if (seconds < 1) return `${(seconds * 1e3).toFixed(1)}ms`;
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
  if (n < 1e15) return `${(n / 1e12).toFixed(1)}T`;
  return `${(n / 1e15).toFixed(1)}P`;
}

// ── Output file ───────────────────────────────────────────────────────
// Filename encodes all mining parameters so same params auto-resume:
//   t<threshold>-<owner1>,<owner2>,...json
const ownersSuffix = owners.map((a) => a.toLowerCase()).join(",");
const outPath = join(import.meta.dir, "tmp", `t${safeThreshold}-${ownersSuffix}.json`);

interface ResultEntry {
  nonce: string;
  address: string;
  leadingZeros: number;
  foundAt: string;
  totalHashesAtDiscovery: number;
}

interface OutputFile {
  controllers: string[];
  threshold: number;
  proxyFactory: string;
  proxyCreationCodeHash: string;
  totalHashes: number;      // cumulative hashes across all runs
  startedAt: string;
  results: ResultEntry[];
}

let output: OutputFile;
let resumedHashes = 0;
if (!noResume) {
  try {
    output = await Bun.file(outPath).json();
    resumedHashes = output.totalHashes ?? 0;
    console.log(`Resuming from ${outPath}`);
    console.log(`  ${output.results.length} prior results, ${formatHashes(resumedHashes)} hashes\n`);
    if (output.results.length > 0) {
      console.log(`  Past results:`);
      for (const r of output.results) {
        console.log(`    ${r.address} (${r.leadingZeros}z, nonce=${r.nonce}, after ${formatHashes(r.totalHashesAtDiscovery)} hashes)`);
      }
      const best = output.results[0];
      const bestSaltHex = "0x" + BigInt(best.nonce).toString(16);
      const bestUrl = new URL(baseUrl);
      bestUrl.searchParams.set("owners", owners.join(","));
      bestUrl.searchParams.set("threshold", safeThreshold.toString());
      bestUrl.searchParams.set("salt", bestSaltHex);
      console.log(`\n  Current best deploy: ${bestUrl.toString()}`);
      console.log();
    }
  } catch {
    output = null as any;
  }
}
if (!output) {
  output = {
    controllers: owners as string[],
    threshold: Number(safeThreshold),
    proxyFactory: PROXY_FACTORY,
    proxyCreationCodeHash: PROXY_CREATION_CODE_HASH,
    totalHashes: 0,
    startedAt: new Date().toISOString(),
    results: [],
  };
  if (noResume) {
    console.log(`Starting fresh (--no-resume)`);
  }
}

async function saveResults(currentTotalHashes: number) {
  output.totalHashes = resumedHashes + currentTotalHashes;
  await Bun.write(outPath, JSON.stringify(output, null, 2) + "\n");
}

// ── Probability math ──────────────────────────────────────────────────
// P(at least one address with N leading zero hex chars in k hashes) = 1 - (1 - 1/16^N)^k
// For 90% chance: k = ln(0.1) / ln(1 - 1/16^N) ≈ ln(10) * 16^N ≈ 2.302585 * 16^N
const LN10 = Math.log(10);

function hashesForNZeros(n: number): number {
  return LN10 * Math.pow(16, n);
}

function expectedHashesForNZeros(n: number): number {
  return Math.pow(16, n);
}

// ── WebGPU init ───────────────────────────────────────────────────────
console.log(`Mining vanity Safe addresses`);
console.log(`  Owners: ${owners.join(", ")}`);
console.log(`  Threshold: ${safeThreshold}`);
console.log(`  Output: ${outPath}`);
console.log();

let adapter: GPUAdapter | null = null;
try {
  const mod = await import("bun-webgpu");
  // @ts-ignore
  if (mod.setupGlobals) mod.setupGlobals();
  // @ts-ignore
  if (mod.createGPUInstance) {
    // @ts-ignore
    const gpu = mod.createGPUInstance();
    adapter = await gpu.requestAdapter();
  }
} catch (e) {
  console.error("Could not load bun-webgpu:", e);
  process.exit(1);
}

if (!adapter) {
  console.error("No WebGPU adapter found.");
  process.exit(1);
}

const device = await adapter.requestDevice();
console.log(`GPU: ${adapter.info.vendor} ${adapter.info.architecture}`);

// ── Shader + buffers (same layout as useSafeMiner.ts) ────────────────
const shaderCode = await Bun.file(join(import.meta.dir, "gnosis-create2.wgsl")).text();
const shaderModule = device.createShaderModule({ code: shaderCode });

const shaderData = prepareShaderData(config);

const constantsData = new Uint32Array(24);
for (let i = 0; i < 8; i++) {
  constantsData[i] =
    (shaderData.initializerHash[i * 4] |
      (shaderData.initializerHash[i * 4 + 1] << 8) |
      (shaderData.initializerHash[i * 4 + 2] << 16) |
      (shaderData.initializerHash[i * 4 + 3] << 24)) >>> 0;
}
for (let i = 0; i < 5; i++) {
  constantsData[8 + i] =
    (shaderData.factoryAddress[i * 4] |
      (shaderData.factoryAddress[i * 4 + 1] << 8) |
      (shaderData.factoryAddress[i * 4 + 2] << 16) |
      (shaderData.factoryAddress[i * 4 + 3] << 24)) >>> 0;
}
for (let i = 0; i < 8; i++) {
  constantsData[13 + i] =
    (shaderData.proxyCodeHash[i * 4] |
      (shaderData.proxyCodeHash[i * 4 + 1] << 8) |
      (shaderData.proxyCodeHash[i * 4 + 2] << 16) |
      (shaderData.proxyCodeHash[i * 4 + 3] << 24)) >>> 0;
}

const constantsBuffer = device.createBuffer({
  size: constantsData.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(constantsBuffer, 0, constantsData);

const paramsBuffer = device.createBuffer({
  size: 16,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

const resultsBuffer = device.createBuffer({
  size: 32,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
});

const readbackBuffer = device.createBuffer({
  size: 32,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});

const pipeline = device.createComputePipeline({
  layout: "auto",
  compute: { module: shaderModule, entryPoint: "main" },
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: constantsBuffer } },
    { binding: 1, resource: { buffer: paramsBuffer } },
    { binding: 2, resource: { buffer: resultsBuffer } },
  ],
});

// ── GPU dispatch helper ──────────────────────────────────────────────
const WORKGROUP_SIZE = 64;
const DISPATCH_X = 65535;
const DISPATCH_Y = 16;
const ITEMS_PER_DISPATCH = WORKGROUP_SIZE * DISPATCH_X * DISPATCH_Y;

function writeGpuBest() {
  const initResults = new Uint32Array(8);
  initResults.fill(0xFFFFFFFF);
  initResults[7] = 0; // found = 0
  device.queue.writeBuffer(resultsBuffer, 0, initResults);
}

async function runOneDispatch(iter: number): Promise<Uint32Array> {
  writeGpuBest();
  const params = new Uint32Array([0, iter, 0, 0]);
  device.queue.writeBuffer(paramsBuffer, 0, params);

  const commandEncoder = device.createCommandEncoder();
  const pass = commandEncoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(DISPATCH_X, DISPATCH_Y);
  pass.end();
  commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, 32);
  device.queue.submit([commandEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();
  return resultData;
}

// ── Warmup: measure hashrate over ~2 seconds ─────────────────────────
console.log(`\nWarming up (2s)...`);
let warmupIter = 0;
const warmupStart = performance.now();
while ((performance.now() - warmupStart) < 2000) {
  await runOneDispatch(warmupIter);
  warmupIter++;
}
const warmupElapsed = (performance.now() - warmupStart) / 1000;
const warmupHashes = warmupIter * ITEMS_PER_DISPATCH;
const measuredHashrate = warmupHashes / warmupElapsed;

console.log(`Hashrate: ${(measuredHashrate / 1e6).toFixed(1)} MH/s\n`);

// ── Print expected time table for 8–14 leading zeros ─────────────────
const SYNDICATE_ATTACK_HASHRATE = 100 * 336e12;  // 100 × Antminer S21 (336 TH/s each) [1]
const NATION_STATE_ATTACK_HASHRATE = 1e21;        // ~1 ZH/s, Bitcoin ATH 7-day avg hashrate, Sep 2025 [2]

console.log(`  Zeros | Expected Hashes | Expected Time  | 90% Chance Hashes | 90% Chance Time | Normal Attack (z+6) | Syndicate Attack (z+8) [1] | Nation-State Attack (z+8) [2]`);
console.log(`  ------+-----------------+----------------+-------------------+-----------------+---------------------+----------------------------+------------------------------`);
for (let z = 8; z <= 14; z++) {
  const expH = expectedHashesForNZeros(z);
  const expT = expH / measuredHashrate;
  const h90 = hashesForNZeros(z);
  const t90 = h90 / measuredHashrate;
  const h90plus6 = hashesForNZeros(z + 6);
  const tNormal = h90plus6 / measuredHashrate;
  const h90plus8 = hashesForNZeros(z + 8);
  const tSyndicate = h90plus8 / SYNDICATE_ATTACK_HASHRATE;
  const tNationState = h90plus8 / NATION_STATE_ATTACK_HASHRATE;
  console.log(
    `  ${String(z).padStart(5)} | ${formatHashes(expH).padStart(15)} | ${formatDuration(expT).padStart(14)} | ${formatHashes(h90).padStart(17)} | ${formatDuration(t90).padStart(15)} | ${formatDuration(tNormal).padStart(19)} | ${formatDuration(tSyndicate).padStart(26)} | ${formatDuration(tNationState).padStart(28)}`
  );
}
console.log(`\n  [1] Syndicate Attack: 100 SOTA miners (Antminer S21, 336 TH/s each) = ${formatHashes(SYNDICATE_ATTACK_HASHRATE)}H/s`);
console.log(`  [2] Nation-State Attack: ~1 ZH/s, Bitcoin ATH 7-day avg hashrate (Sep 2025)`);
console.log();

// ── Mining state ─────────────────────────────────────────────────────
let iteration = warmupIter; // continue from warmup iterations
let totalHashes = warmupHashes;
const startTime = performance.now() - warmupElapsed * 1000; // account for warmup

let bestAddress: bigint = BigInt("0x" + "f".repeat(40));
if (output.results.length > 0) {
  bestAddress = BigInt(output.results[0].address);
}

// Locked target zeros for 90% countdown (same logic as web UI)
let currentBestZeros = output.results.length > 0 ? output.results[0].leadingZeros : 0;
let lockedTargetZeros = currentBestZeros + 1;
let hashesSinceLock = 0;

// Graceful shutdown
let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(0);
  stopping = true;
  console.log("\nStopping after current dispatch... (Ctrl+C again to force)");
});

console.log(`Mining started. Press Ctrl+C to stop.\n`);

while (!stopping) {
  const resultData = await runOneDispatch(iteration);
  const found = resultData[7] === 1;

  if (found) {
    const nonceLow = resultData[0];
    const nonceHigh = resultData[1];
    const gpuNonce = BigInt(nonceHigh) * BigInt(0x100000000) + BigInt(nonceLow);

    const verified = deriveSafeAddress(config, gpuNonce);
    const addrBigInt = BigInt(verified.address);

    if (addrBigInt < bestAddress) {
      bestAddress = addrBigInt;
      const zeros = countLeadingZeros(verified.address);

      totalHashes = (iteration + 1) * ITEMS_PER_DISPATCH;
      const entry: ResultEntry = {
        nonce: gpuNonce.toString(),
        address: verified.address,
        leadingZeros: zeros,
        foundAt: new Date().toISOString(),
        totalHashesAtDiscovery: resumedHashes + totalHashes,
      };

      output.results.push(entry);
      output.results.sort((a, b) => {
        const addrA = BigInt(a.address);
        const addrB = BigInt(b.address);
        if (addrA < addrB) return -1;
        if (addrA > addrB) return 1;
        return 0;
      });

      await saveResults(totalHashes);

      const elapsed = ((performance.now() - startTime) / 1000).toFixed(0);
      const saltHex = "0x" + gpuNonce.toString(16);
      const deployUrl = new URL(baseUrl);
      deployUrl.searchParams.set("owners", owners.join(","));
      deployUrl.searchParams.set("threshold", safeThreshold.toString());
      deployUrl.searchParams.set("salt", saltHex);
      console.log(`\n  NEW BEST: ${verified.address} (${zeros} leading zeros, nonce=${gpuNonce}, ${elapsed}s)`);
      console.log(`  deploy: ${deployUrl.toString()}`);

      // Update locked target if we found more zeros
      if (zeros > currentBestZeros) {
        currentBestZeros = zeros;
        const newTarget = zeros + 1;
        if (newTarget > lockedTargetZeros) {
          lockedTargetZeros = newTarget;
          hashesSinceLock = 0;
        }
      }
    }
  }

  iteration++;
  hashesSinceLock += ITEMS_PER_DISPATCH;
  totalHashes = iteration * ITEMS_PER_DISPATCH;

  // Check if we should bump the locked target (>50% of predicted hashes with no improvement)
  const hashesFor90 = hashesForNZeros(lockedTargetZeros);
  const progressForLocked = hashesSinceLock / hashesFor90;
  if (progressForLocked >= 0.5) {
    const newTarget = currentBestZeros + 1;
    if (newTarget !== lockedTargetZeros) {
      lockedTargetZeros = newTarget;
      hashesSinceLock = 0;
    }
  }

  const now = performance.now();
  const elapsed = (now - startTime) / 1000;
  const hashrate = totalHashes / elapsed;

  // 90% countdown for next zero
  const h90 = hashesForNZeros(lockedTargetZeros);
  const remaining90 = Math.max(0, h90 - hashesSinceLock);
  const remaining90sec = hashrate > 0 ? remaining90 / hashrate : Infinity;
  // Cumulative probability of having found target by now:
  // P(found) = 1 - (1 - 1/16^N)^k ≈ 1 - e^(-k/16^N)
  const p = 1 / Math.pow(16, lockedTargetZeros);
  const probFound = 1 - Math.exp(-hashesSinceLock * p);
  const probPercent = Math.min(99.999, probFound * 100);
  const isOverdue = hashesSinceLock > h90;

  let statusStr: string;
  if (isOverdue) {
    // Show how unlucky: "expected 99.2% by now"
    statusStr = `${probPercent.toFixed(1)}% expected by now, +${formatDuration((hashesSinceLock - h90) / hashrate)} overdue`;
  } else {
    const countdownStr = formatDuration(remaining90sec);
    statusStr = `${probPercent.toFixed(1)}% chance done, ETA 90%: ${countdownStr}`;
  }

  process.stdout.write(
    `\r  ${formatDuration(elapsed)} | ${(hashrate / 1e6).toFixed(1)} MH/s | ${formatHashes(totalHashes)} hashes | best: ${currentBestZeros}z` +
    ` | ${lockedTargetZeros}z: ${statusStr}   `
  );
}

// Final save
await saveResults(totalHashes);
const finalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nDone. ${finalElapsed}s, ${output.results.length} results saved to ${outPath}`);
