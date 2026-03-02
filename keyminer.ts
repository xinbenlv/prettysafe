#!/usr/bin/env bun
/**
 * CLI vanity EVM address miner via private key iteration.
 * Uses WebGPU (via bun-webgpu) to brute-force private keys on GPU.
 * Pipeline: private_key → secp256k1(G) → keccak256 → address
 *
 * Optimization: CPU precomputes base_point and a 3-level table of G multiples.
 * GPU threads do at most 3 EC additions + 1 mod_inv instead of full scalar multiply.
 *
 * Usage:
 *   bun run keyminer.ts [--start-key 0x...] [--leading-zeros 8] [--no-resume]
 *
 * WARNING: This tool displays private keys in the terminal.
 *          Anyone with access to a private key controls the corresponding wallet.
 */

import { join } from "path";
import { parseArgs } from "util";
import { Wallet, SigningKey } from "ethers";

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
// This gives each run a unique 2^128 key range, enabling parallelization and
// ensuring reruns don't repeat the same key space.
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

// Parse 256-bit hex → 8 little-endian u32 limbs
function hexToLimbs(hex: string): Uint32Array {
  const clean = hex.replace("0x", "").padStart(64, "0");
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const byteOffset = (7 - i) * 8;
    limbs[i] = parseInt(clean.slice(byteOffset, byteOffset + 8), 16) >>> 0;
  }
  return limbs;
}

function limbsToHex(limbs: Uint32Array | number[]): string {
  let hex = "0x";
  for (let i = 7; i >= 0; i--) {
    hex += (limbs[i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
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

function bigintToHex64(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

// ── EC point precomputation using ethers ──────────────────────────────

// Returns affine point (x, y) as little-endian u32 limbs, or null for identity
function computeECPoint(scalar: bigint): { x: Uint32Array; y: Uint32Array } | null {
  if (scalar === 0n) return null;
  // Ensure scalar is within secp256k1 order
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const s = ((scalar % n) + n) % n;
  if (s === 0n) return null;
  const sk = new SigningKey(bigintToHex64(s));
  const pub = sk.publicKey; // "0x04" + 64 hex x + 64 hex y
  return {
    x: hexToLimbs("0x" + pub.slice(4, 68)),
    y: hexToLimbs("0x" + pub.slice(68, 132)),
  };
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
const outPath = join(import.meta.dir, "tmp", `keyminer-${keyPrefix}.json`);

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

// ── WebGPU init ───────────────────────────────────────────────────────
console.log(`\n⚠️  WARNING: This tool displays private keys in the terminal.`);
console.log(`   Anyone with the private key controls the corresponding wallet.\n`);
console.log(`Mining vanity EVM addresses via private key iteration`);
console.log(`  Start key: ${startKeyHex}`);
console.log(`  Target: ${targetZeros} leading zeros`);
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

// ── Precompute EC table ──────────────────────────────────────────────
// 3-level table of G multiples for fast GPU lookups:
//   Table A [0..63]:      i * G           (local thread offset)
//   Table B [64..1087]:   i * 64 * G      (workgroup x offset)
//   Table C [1088..1103]: i * 65536 * G   (workgroup y offset)
// Total: 1104 affine points, each 16 u32s = 70,656 bytes

console.log("Precomputing EC point table...");
const TABLE_A_SIZE = 64;    // matches workgroup_size
const TABLE_B_SIZE = 1024;  // matches DISPATCH_X
const TABLE_C_SIZE = 16;    // matches DISPATCH_Y
const TABLE_TOTAL = TABLE_A_SIZE + TABLE_B_SIZE + TABLE_C_SIZE; // 1104

const tableData = new Uint32Array(TABLE_TOTAL * 16); // 16 u32s per point

function writePointToTable(idx: number, pt: { x: Uint32Array; y: Uint32Array } | null) {
  const base = idx * 16;
  if (pt === null) {
    // Identity: all zeros
    for (let i = 0; i < 16; i++) tableData[base + i] = 0;
  } else {
    for (let i = 0; i < 8; i++) tableData[base + i] = pt.x[i];
    for (let i = 0; i < 8; i++) tableData[base + 8 + i] = pt.y[i];
  }
}

// Table A: i * G for i = 0..63
for (let i = 0; i < TABLE_A_SIZE; i++) {
  writePointToTable(i, computeECPoint(BigInt(i)));
}

// Table B: (i * 64) * G for i = 0..1023
for (let i = 0; i < TABLE_B_SIZE; i++) {
  writePointToTable(TABLE_A_SIZE + i, computeECPoint(BigInt(i) * 64n));
}

// Table C: (i * 65536) * G for i = 0..15
for (let i = 0; i < TABLE_C_SIZE; i++) {
  writePointToTable(TABLE_A_SIZE + TABLE_B_SIZE + i, computeECPoint(BigInt(i) * 65536n));
}

console.log(`  ${TABLE_TOTAL} points precomputed (${(tableData.byteLength / 1024).toFixed(0)} KB)`);

// ── Shader + buffers ──────────────────────────────────────────────────
const shaderCode = await Bun.file(
  join(import.meta.dir, "keyminer.wgsl")
).text();
const shaderModule = device.createShaderModule({ code: shaderCode });

// Params: 6 vec4<u32> = 96 bytes (base_x, base_y, base_scalar)
const PARAMS_SIZE = 96;
const paramsBuffer = device.createBuffer({
  size: PARAMS_SIZE,
  usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
});

// Results: 14 u32 = 56 bytes
const RESULTS_SIZE = 56;
const resultsBuffer = device.createBuffer({
  size: RESULTS_SIZE,
  usage:
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
});

const readbackBuffer = device.createBuffer({
  size: RESULTS_SIZE,
  usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
});

// EC table buffer (storage, read-only)
const tableBuffer = device.createBuffer({
  size: tableData.byteLength,
  usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
});
device.queue.writeBuffer(tableBuffer, 0, tableData);

const pipeline = device.createComputePipeline({
  layout: "auto",
  compute: { module: shaderModule, entryPoint: "main" },
});

const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: paramsBuffer } },
    { binding: 1, resource: { buffer: resultsBuffer } },
    { binding: 2, resource: { buffer: tableBuffer } },
  ],
});

// ── GPU dispatch ──────────────────────────────────────────────────────
const WORKGROUP_SIZE = 64;
const DISPATCH_X = TABLE_B_SIZE;  // 1024
const DISPATCH_Y = TABLE_C_SIZE;  // 16
const ITEMS_PER_DISPATCH = WORKGROUP_SIZE * DISPATCH_X * DISPATCH_Y; // 1,048,576

const startKeyBigInt = BigInt(startKeyHex);

function writeGpuBest() {
  const initResults = new Uint32Array(14);
  initResults.fill(0xffffffff);
  initResults[13] = 0; // found = 0
  device.queue.writeBuffer(resultsBuffer, 0, initResults);
}

async function runOneDispatch(offset: number): Promise<Uint32Array> {
  writeGpuBest();

  // CPU computes base_point = (startKey + offset) * G
  const baseScalar = startKeyBigInt + BigInt(offset);
  const basePoint = computeECPoint(baseScalar);

  // Write params: base_x (8), base_y (8), base_scalar (8) = 24 u32s = 96 bytes
  const paramsData = new Uint32Array(24);
  if (basePoint) {
    for (let i = 0; i < 8; i++) paramsData[i] = basePoint.x[i];
    for (let i = 0; i < 8; i++) paramsData[8 + i] = basePoint.y[i];
  }
  // base_scalar
  const scalarLimbs = hexToLimbs(bigintToHex64(baseScalar));
  for (let i = 0; i < 8; i++) paramsData[16 + i] = scalarLimbs[i];
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const commandEncoder = device.createCommandEncoder();
  const pass = commandEncoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(DISPATCH_X, DISPATCH_Y);
  pass.end();
  commandEncoder.copyBufferToBuffer(
    resultsBuffer,
    0,
    readbackBuffer,
    0,
    RESULTS_SIZE
  );
  device.queue.submit([commandEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Uint32Array(
    readbackBuffer.getMappedRange().slice(0)
  );
  readbackBuffer.unmap();
  return resultData;
}

// ── CPU verification ──────────────────────────────────────────────────
function verifyKeyAddress(
  keyHex: string
): { address: string; valid: boolean } {
  try {
    const wallet = new Wallet(keyHex);
    return { address: wallet.address.toLowerCase(), valid: true };
  } catch {
    return { address: "", valid: false };
  }
}

// ── Warmup ────────────────────────────────────────────────────────────
console.log(`\nWarming up (2s)...`);
let warmupIter = 0;
const warmupStart = performance.now();
let currentOffset = resumedOffset;

while (performance.now() - warmupStart < 2000) {
  await runOneDispatch(currentOffset);
  currentOffset += ITEMS_PER_DISPATCH;
  warmupIter++;
}
const warmupElapsed = (performance.now() - warmupStart) / 1000;
const warmupKeys = warmupIter * ITEMS_PER_DISPATCH;
const measuredRate = warmupKeys / warmupElapsed;

console.log(`Rate: ${(measuredRate / 1e6).toFixed(2)} M keys/s\n`);

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
    "\nStopping after current dispatch... (Ctrl+C again to force)"
  );
});

console.log(`Mining started. Press Ctrl+C to stop.\n`);

while (!stopping) {
  const resultData = await runOneDispatch(currentOffset);
  const found = resultData[13] === 1;

  if (found) {
    const keyLimbs = resultData.slice(5, 13);
    const keyHex = limbsToHex(Array.from(keyLimbs));
    const { address: cpuAddress, valid } = verifyKeyAddress(keyHex);

    if (valid) {
      const addrBigInt = BigInt(cpuAddress);
      const zeros = countLeadingZeroHex(cpuAddress);

      if (addrBigInt < bestAddress) {
        bestAddress = addrBigInt;

        totalKeys = currentOffset - resumedOffset + ITEMS_PER_DISPATCH;
        const entry: ResultEntry = {
          privateKey: keyHex,
          address: cpuAddress,
          leadingZeros: zeros,
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
          `\n  NEW BEST: ${cpuAddress} (${zeros} leading zeros, ${elapsed}s)`
        );
        console.log(`  key: ${keyHex}`);

        if (zeros > currentBestZeros) {
          currentBestZeros = zeros;
          const newTarget = zeros + 1;
          if (newTarget > lockedTargetZeros) {
            lockedTargetZeros = newTarget;
            keysSinceLock = 0;
          }
        }

        if (zeros >= targetZeros) {
          console.log(
            `\n  Target of ${targetZeros} leading zeros reached!`
          );
          stopping = true;
        }
      }
    }
  }

  currentOffset += ITEMS_PER_DISPATCH;
  keysSinceLock += ITEMS_PER_DISPATCH;
  totalKeys = currentOffset - resumedOffset;

  const now = performance.now();
  const elapsed = (now - startTime) / 1000;
  const rate = totalKeys / elapsed;

  const h90 = hashesForNZeros(lockedTargetZeros);
  const remaining90 = Math.max(0, h90 - keysSinceLock);
  const remaining90sec = rate > 0 ? remaining90 / rate : Infinity;
  const p = 1 / Math.pow(16, lockedTargetZeros);
  const probFound = 1 - Math.exp(-keysSinceLock * p);
  const probPercent = Math.min(99.999, probFound * 100);

  process.stdout.write(
    `\r  ${formatDuration(elapsed)} | ${(rate / 1e6).toFixed(2)} M/s | ${formatHashes(totalKeys)} keys | best: ${currentBestZeros}z` +
      ` | ${lockedTargetZeros}z: ${probPercent.toFixed(1)}% ETA: ${formatDuration(remaining90sec)}   `
  );
}

// Final save
await saveResults(totalKeys, currentOffset);
const finalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
console.log(
  `\n\nDone. ${finalElapsed}s, ${output.results.length} results saved to ${outPath}`
);
