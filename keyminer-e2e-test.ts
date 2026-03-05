#!/usr/bin/env bun
/**
 * 5 deterministic end-to-end tests for the GPU keyminer pipeline.
 *
 * Each test uses a specific starting private key and verifies:
 *   1. Thread 0 public key matches CPU (ethers.js SigningKey)
 *   2. Thread 0 keccak hash matches CPU (ethers.js keccak256)
 *   3. Thread 0 private key round-trips correctly
 *   4. GPU best-result key produces the correct address on CPU
 *   5. GPU best-result address bytes match CPU-derived address
 *
 * WARNING: All private keys and addresses in this file are TEST-ONLY.
 *    They are PUBLIC TEST DATA — DO NOT send real funds to these addresses.
 */

import { join } from "path";
import { Wallet, SigningKey, keccak256 } from "ethers";

// ── Helpers ─────────────────────────────────────────────────────────

function hexToLimbs(hex: string): Uint32Array {
  const clean = hex.replace("0x", "").padStart(64, "0");
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const byteOffset = (7 - i) * 8;
    limbs[i] = parseInt(clean.slice(byteOffset, byteOffset + 8), 16) >>> 0;
  }
  return limbs;
}

function limbsToHex(limbs: Uint32Array | number[], offset = 0, count = 8): string {
  let hex = "0x";
  for (let i = count - 1; i >= 0; i--) {
    hex += (limbs[offset + i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

function bigintToHex64(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

function computeECPoint(scalar: bigint): { x: Uint32Array; y: Uint32Array } | null {
  if (scalar === 0n) return null;
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const s = ((scalar % n) + n) % n;
  if (s === 0n) return null;
  const sk = new SigningKey(bigintToHex64(s));
  const pub = sk.publicKey;
  return {
    x: hexToLimbs("0x" + pub.slice(4, 68)),
    y: hexToLimbs("0x" + pub.slice(68, 132)),
  };
}

/** Decode GPU debug hash (LE lane format) to hex string */
function gpuHashToHex(debugData: Uint32Array, hashOffset: number): string {
  let hex = "0x";
  for (let i = 0; i < 4; i++) {
    const lo = debugData[hashOffset + i * 2];
    const hi = debugData[hashOffset + i * 2 + 1];
    for (const word of [lo, hi]) {
      hex += (word & 0xff).toString(16).padStart(2, "0");
      hex += ((word >> 8) & 0xff).toString(16).padStart(2, "0");
      hex += ((word >> 16) & 0xff).toString(16).padStart(2, "0");
      hex += ((word >> 24) & 0xff).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/** Decode GPU debug pubkey (big-endian u32s) to hex string */
function gpuPubToHex(debugData: Uint32Array): string {
  let hex = "0x";
  for (let i = 0; i < 16; i++) {
    hex += (debugData[i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

/** Convert big-endian u32 pubkey from debug buffer to raw bytes for CPU hash */
function gpuPubToBytes(debugData: Uint32Array): Uint8Array {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const w = debugData[i];
    bytes[i * 4] = (w >> 24) & 0xff;
    bytes[i * 4 + 1] = (w >> 16) & 0xff;
    bytes[i * 4 + 2] = (w >> 8) & 0xff;
    bytes[i * 4 + 3] = w & 0xff;
  }
  return bytes;
}

/** Reconstruct GPU best-result address from result words (native endian → hex) */
function gpuAddrToHex(resultData: Uint32Array): string {
  let hex = "0x";
  for (let i = 0; i < 5; i++) {
    const w = resultData[i];
    // swap endian (GPU stores in native LE, address is BE)
    const swapped =
      ((w & 0xff) << 24) |
      (((w >> 8) & 0xff) << 16) |
      (((w >> 16) & 0xff) << 8) |
      ((w >> 24) & 0xff);
    hex += (swapped >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

// ── GPU init ────────────────────────────────────────────────────────

async function initGPU(): Promise<GPUDevice> {
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
    throw new Error(`Could not load bun-webgpu: ${e}`);
  }
  if (!adapter) throw new Error("No WebGPU adapter found.");
  return adapter.requestDevice();
}

// ── GPU dispatch harness ────────────────────────────────────────────

const TABLE_A_SIZE = 64;
const TABLE_B_SIZE = 1024;
const TABLE_C_SIZE = 16;
const TABLE_TOTAL = TABLE_A_SIZE + TABLE_B_SIZE + TABLE_C_SIZE;
const DISPATCH_X = TABLE_B_SIZE;
const DISPATCH_Y = TABLE_C_SIZE;
const PARAMS_SIZE = 96;
const RESULTS_SIZE = 56;
const DEBUG_SIZE = 32 * 4;

async function buildPipeline(device: GPUDevice) {
  const shaderCode = [
    await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-field.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "wgsl", "keccak256.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-ec.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "keyminer.wgsl")).text(),
  ].join("\n");

  const shaderModule = device.createShaderModule({ code: shaderCode });

  // Precompute EC table (shared across all tests)
  const tableData = new Uint32Array(TABLE_TOTAL * 16);
  function writePoint(idx: number, pt: { x: Uint32Array; y: Uint32Array } | null) {
    const base = idx * 16;
    if (pt === null) {
      for (let i = 0; i < 16; i++) tableData[base + i] = 0;
    } else {
      for (let i = 0; i < 8; i++) tableData[base + i] = pt.x[i];
      for (let i = 0; i < 8; i++) tableData[base + 8 + i] = pt.y[i];
    }
  }
  for (let i = 0; i < TABLE_A_SIZE; i++) writePoint(i, computeECPoint(BigInt(i)));
  for (let i = 0; i < TABLE_B_SIZE; i++) writePoint(TABLE_A_SIZE + i, computeECPoint(BigInt(i) * 64n));
  for (let i = 0; i < TABLE_C_SIZE; i++) writePoint(TABLE_A_SIZE + TABLE_B_SIZE + i, computeECPoint(BigInt(i) * 65536n));

  const paramsBuffer = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const resultsBuffer = device.createBuffer({ size: RESULTS_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const readbackBuffer = device.createBuffer({ size: RESULTS_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const tableBuffer = device.createBuffer({ size: tableData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const debugBuffer = device.createBuffer({ size: DEBUG_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const debugReadback = device.createBuffer({ size: DEBUG_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

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
      { binding: 3, resource: { buffer: debugBuffer } },
    ],
  });

  return { pipeline, bindGroup, paramsBuffer, resultsBuffer, readbackBuffer, debugBuffer, debugReadback, device };
}

async function runDispatch(
  ctx: Awaited<ReturnType<typeof buildPipeline>>,
  startKey: bigint
): Promise<{ results: Uint32Array; debug: Uint32Array }> {
  const { pipeline, bindGroup, paramsBuffer, resultsBuffer, readbackBuffer, debugBuffer, debugReadback, device } = ctx;

  // Init results to 0xff (worst address)
  const initResults = new Uint32Array(14);
  initResults.fill(0xffffffff);
  initResults[13] = 0;
  device.queue.writeBuffer(resultsBuffer, 0, initResults);
  device.queue.writeBuffer(debugBuffer, 0, new Uint32Array(32));

  // Write params
  const basePoint = computeECPoint(startKey)!;
  const paramsData = new Uint32Array(24);
  for (let i = 0; i < 8; i++) paramsData[i] = basePoint.x[i];
  for (let i = 0; i < 8; i++) paramsData[8 + i] = basePoint.y[i];
  const scalarLimbs = hexToLimbs(bigintToHex64(startKey));
  for (let i = 0; i < 8; i++) paramsData[16 + i] = scalarLimbs[i];
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(DISPATCH_X, DISPATCH_Y);
  pass.end();
  encoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, RESULTS_SIZE);
  encoder.copyBufferToBuffer(debugBuffer, 0, debugReadback, 0, DEBUG_SIZE);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  await debugReadback.mapAsync(GPUMapMode.READ);
  const debugData = new Uint32Array(debugReadback.getMappedRange().slice(0));
  debugReadback.unmap();

  return { results: resultData, debug: debugData };
}

// ── Test runner ─────────────────────────────────────────────────────

interface TestCase {
  name: string;
  startKey: bigint;
}

const SECP256K1_ORDER = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;

const TEST_CASES: TestCase[] = [
  {
    name: "key=1 (generator point G)",
    startKey: 1n,
  },
  {
    name: "key=2 (2*G)",
    startKey: 2n,
  },
  {
    name: "key=0xd84097 (known test vector)",
    startKey: 0xd84097n,
  },
  {
    name: "key=0xdeadbeefcafebabe0123456789abcdef (mid-range)",
    startKey: 0xdeadbeefcafebabe0123456789abcdefdeadbeefcafebabe0123456789abcdefn,
  },
  {
    name: "key=order-2^21 (near curve order, safe from overflow)",
    startKey: SECP256K1_ORDER - (1n << 21n),
  },
];

function verifyThread0(
  testName: string,
  startKey: bigint,
  debugData: Uint32Array
): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  const startKeyHex = bigintToHex64(startKey);

  // 1. Verify pubkey
  const gpuPubHex = gpuPubToHex(debugData);
  const sk = new SigningKey(startKeyHex);
  const cpuPubXY = "0x" + sk.publicKey.slice(4);

  if (gpuPubHex.toLowerCase() === cpuPubXY.toLowerCase()) {
    console.log(`    PASS: thread 0 pubkey matches CPU`);
    passed++;
  } else {
    console.log(`    FAIL: thread 0 pubkey mismatch`);
    console.log(`      GPU: ${gpuPubHex}`);
    console.log(`      CPU: ${cpuPubXY}`);
    failed++;
  }

  // 2. Verify keccak hash
  const pubBytes = gpuPubToBytes(debugData);
  const cpuHash = keccak256(pubBytes);
  const gpuHashHex = gpuHashToHex(debugData, 16);

  if (gpuHashHex.toLowerCase() === cpuHash.toLowerCase()) {
    console.log(`    PASS: thread 0 keccak hash matches CPU`);
    passed++;
  } else {
    console.log(`    FAIL: thread 0 keccak hash mismatch`);
    console.log(`      GPU: ${gpuHashHex}`);
    console.log(`      CPU: ${cpuHash}`);
    failed++;
  }

  // 3. Verify private key round-trip
  const gpuKey = limbsToHex(Array.from(debugData), 24, 8);
  if (gpuKey.toLowerCase() === startKeyHex.toLowerCase()) {
    console.log(`    PASS: thread 0 private key matches`);
    passed++;
  } else {
    console.log(`    FAIL: thread 0 private key mismatch`);
    console.log(`      GPU: ${gpuKey}`);
    console.log(`      CPU: ${startKeyHex}`);
    failed++;
  }

  return { passed, failed };
}

function verifyBestResult(
  testName: string,
  startKey: bigint,
  resultData: Uint32Array
): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  const found = resultData[13] === 1;
  if (!found) {
    console.log(`    SKIP: no best result (all addresses worse than 0xff...ff)`);
    return { passed, failed };
  }

  // 4. Verify best-result key produces valid address
  const keyLimbs = resultData.slice(5, 13);
  const keyHex = limbsToHex(Array.from(keyLimbs));
  let cpuAddr: string;
  try {
    const wallet = new Wallet(keyHex);
    cpuAddr = wallet.address.toLowerCase();
    console.log(`    PASS: best key produces valid address`);
    console.log(`      key:  ${keyHex}`);
    console.log(`      addr: ${cpuAddr}`);
    passed++;
  } catch (e) {
    console.log(`    FAIL: best key is invalid: ${keyHex}`);
    failed++;
    return { passed, failed };
  }

  // 5. Verify GPU address bytes match CPU-derived address
  const gpuAddr = gpuAddrToHex(resultData);
  // CPU address is checksummed; compare lowercase without 0x
  const cpuAddrClean = cpuAddr.replace("0x", "").toLowerCase();
  const gpuAddrClean = gpuAddr.replace("0x", "").toLowerCase();

  if (gpuAddrClean === cpuAddrClean) {
    console.log(`    PASS: GPU address bytes match CPU`);
    passed++;
  } else {
    console.log(`    FAIL: GPU address bytes mismatch`);
    console.log(`      GPU addr: ${gpuAddr}`);
    console.log(`      CPU addr: ${cpuAddr}`);
    failed++;
  }

  return { passed, failed };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("KEYMINER GPU E2E TESTS (5 deterministic starting keys)");
  console.log("======================================================\n");
  console.log("WARNING: All keys below are PUBLIC TEST DATA — never use for real funds.\n");

  const device = await initGPU();
  console.log("Building GPU pipeline...");
  const ctx = await buildPipeline(device);
  console.log("Pipeline ready.\n");

  let totalPassed = 0;
  let totalFailed = 0;

  for (let t = 0; t < TEST_CASES.length; t++) {
    const tc = TEST_CASES[t];
    console.log(`Test ${t + 1}/5: ${tc.name}`);
    console.log(`  start_key = ${bigintToHex64(tc.startKey)}`);

    const { results, debug } = await runDispatch(ctx, tc.startKey);

    console.log("  Thread 0 verification:");
    const { passed: p1, failed: f1 } = verifyThread0(tc.name, tc.startKey, debug);
    totalPassed += p1;
    totalFailed += f1;

    console.log("  Best result verification:");
    const { passed: p2, failed: f2 } = verifyBestResult(tc.name, tc.startKey, results);
    totalPassed += p2;
    totalFailed += f2;

    console.log();
  }

  console.log("======================================================");
  console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
  console.log("======================================================");
  console.log("\nWARNING: All keys above are PUBLIC TEST DATA — never use for real funds.");

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
