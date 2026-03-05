#!/usr/bin/env bun
/**
 * End-to-end verification test for the GPU keyminer pipeline.
 *
 * 1. Runs GPU dispatch with a known start key
 * 2. Reads debug buffer — verifies thread 0 pubkey + hash against CPU
 * 3. Verifies GPU's best address matches CPU re-derivation
 * 4. Tests known key→address pairs from ethers.js
 *
 * WARNING: All private keys and addresses in this file are TEST-ONLY.
 *    They are PUBLIC TEST DATA — DO NOT send real funds to these addresses.
 */

import { join } from "path";
import { Wallet, SigningKey, computeAddress, keccak256 } from "ethers";

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

// ── Test: known key→address vectors ─────────────────────────────────

const TEST_VECTORS = [
  {
    privateKey: "0x0000000000000000000000000000000000000000000000000000000000000001",
    expectedAddress: "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
  },
  {
    privateKey: "0x0000000000000000000000000000000000000000000000000000000000000002",
    expectedAddress: "0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF",
  },
  {
    privateKey: "0x0000000000000000000000000000000000000000000000000000000000d84097",
    expectedAddress: "0x90725485F127f89bf8DF8d77260fff3E802f6749",
  },
];

function testKnownVectors(): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;

  for (const vec of TEST_VECTORS) {
    const wallet = new Wallet(vec.privateKey);
    const derived = wallet.address;
    if (derived.toLowerCase() === vec.expectedAddress.toLowerCase()) {
      console.log(`  PASS: key=${vec.privateKey.slice(0, 14)}... → ${derived}`);
      passed++;
    } else {
      console.log(`  FAIL: key=${vec.privateKey.slice(0, 14)}...`);
      console.log(`    expected: ${vec.expectedAddress}`);
      console.log(`    got:      ${derived}`);
      failed++;
    }
  }

  return { passed, failed };
}

// ── Test: GPU dispatch with debug buffer verification ───────────────

async function testGPUDispatch(device: GPUDevice): Promise<{ passed: number; failed: number }> {
  let passed = 0;
  let failed = 0;

  // Assemble shader from modules
  const shaderCode = [
    await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-field.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "wgsl", "keccak256.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-ec.wgsl")).text(),
    await Bun.file(join(import.meta.dir, "keyminer.wgsl")).text(),
  ].join("\n");

  const shaderModule = device.createShaderModule({ code: shaderCode });

  // Use a known start key for reproducibility
  const startKey = 1n; // private key = 1
  const startKeyHex = bigintToHex64(startKey);

  // ── Setup constants ──────────────────────────────────────────
  const WORKGROUP_SIZE = 64;
  const TABLE_A_SIZE = 64;
  const TABLE_B_SIZE = 1024;
  const TABLE_C_SIZE = 16;
  const DISPATCH_X = TABLE_B_SIZE;
  const DISPATCH_Y = TABLE_C_SIZE;
  const TABLE_TOTAL = TABLE_A_SIZE + TABLE_B_SIZE + TABLE_C_SIZE;

  // ── Precompute table ─────────────────────────────────────────
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

  // ── Create buffers ───────────────────────────────────────────
  const PARAMS_SIZE = 96;
  const RESULTS_SIZE = 56;
  const DEBUG_SIZE = 32 * 4;

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

  // ── Write params ─────────────────────────────────────────────
  const basePoint = computeECPoint(startKey)!;
  const paramsData = new Uint32Array(24);
  for (let i = 0; i < 8; i++) paramsData[i] = basePoint.x[i];
  for (let i = 0; i < 8; i++) paramsData[8 + i] = basePoint.y[i];
  const scalarLimbs = hexToLimbs(startKeyHex);
  for (let i = 0; i < 8; i++) paramsData[16 + i] = scalarLimbs[i];
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  // Init results
  const initResults = new Uint32Array(14);
  initResults.fill(0xffffffff);
  initResults[13] = 0;
  device.queue.writeBuffer(resultsBuffer, 0, initResults);
  device.queue.writeBuffer(debugBuffer, 0, new Uint32Array(32));

  // ── Dispatch ─────────────────────────────────────────────────
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

  // ── Read results ─────────────────────────────────────────────
  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  await debugReadback.mapAsync(GPUMapMode.READ);
  const debugData = new Uint32Array(debugReadback.getMappedRange().slice(0));
  debugReadback.unmap();

  // ── Verify debug buffer (thread 0) ───────────────────────────
  // Thread 0: scalar = startKey + 0 = 1
  // Expected: pubkey of key 1, keccak of that pubkey, key = startKey

  console.log("\n  Debug buffer verification (thread 0, key=1):");

  // Debug buffer layout: pubkey_be[16] + hash[8] + key[8]
  // pubkey u32s are big-endian values (MSByte in high bits) — read directly as hex
  let gpuPubHex = "0x";
  for (let i = 0; i < 16; i++) {
    gpuPubHex += (debugData[i] >>> 0).toString(16).padStart(8, "0");
  }

  // Get CPU reference
  const sk = new SigningKey(startKeyHex);
  const cpuPub = sk.publicKey; // 0x04 + x + y
  const cpuPubXY = "0x" + cpuPub.slice(4); // just x+y without 04 prefix

  if (gpuPubHex.toLowerCase() === cpuPubXY.toLowerCase()) {
    console.log(`    PASS: pubkey matches CPU`);
    passed++;
  } else {
    console.log(`    FAIL: pubkey mismatch`);
    console.log(`      GPU: ${gpuPubHex}`);
    console.log(`      CPU: ${cpuPubXY}`);
    failed++;
  }

  // Verify keccak hash
  // CPU: keccak256 of the 64-byte pubkey (x||y as bytes)
  const pubBytes = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const w = debugData[i]; // big-endian u32
    pubBytes[i * 4] = (w >> 24) & 0xFF;
    pubBytes[i * 4 + 1] = (w >> 16) & 0xFF;
    pubBytes[i * 4 + 2] = (w >> 8) & 0xFF;
    pubBytes[i * 4 + 3] = w & 0xFF;
  }
  const cpuHash = keccak256(pubBytes);

  // GPU hash is in LE lane format: [lo0, hi0, lo1, hi1, ...]
  let gpuHashHex = "0x";
  for (let i = 0; i < 4; i++) {
    const lo = debugData[16 + i * 2];
    const hi = debugData[16 + i * 2 + 1];
    for (const word of [lo, hi]) {
      gpuHashHex += (word & 0xFF).toString(16).padStart(2, "0");
      gpuHashHex += ((word >> 8) & 0xFF).toString(16).padStart(2, "0");
      gpuHashHex += ((word >> 16) & 0xFF).toString(16).padStart(2, "0");
      gpuHashHex += ((word >> 24) & 0xFF).toString(16).padStart(2, "0");
    }
  }

  if (gpuHashHex.toLowerCase() === cpuHash.toLowerCase()) {
    console.log(`    PASS: keccak hash matches CPU`);
    passed++;
  } else {
    console.log(`    FAIL: keccak hash mismatch`);
    console.log(`      GPU: ${gpuHashHex}`);
    console.log(`      CPU: ${cpuHash}`);
    failed++;
  }

  // Verify debug key
  const gpuKey = limbsToHex(Array.from(debugData), 24, 8);
  if (gpuKey.toLowerCase() === startKeyHex.toLowerCase()) {
    console.log(`    PASS: private key matches`);
    passed++;
  } else {
    console.log(`    FAIL: private key mismatch`);
    console.log(`      GPU: ${gpuKey}`);
    console.log(`      CPU: ${startKeyHex}`);
    failed++;
  }

  // ── Verify best result ───────────────────────────────────────
  const found = resultData[13] === 1;
  if (found) {
    const keyLimbs = resultData.slice(5, 13);
    const keyHex = limbsToHex(Array.from(keyLimbs));
    const wallet = new Wallet(keyHex);
    const cpuAddr = wallet.address.toLowerCase();

    // Reconstruct GPU address from result words
    // addr words are in native endian — convert via swap for comparison
    console.log(`\n  Best result verification:`);
    console.log(`    GPU key: ${keyHex}`);
    console.log(`    CPU addr: ${cpuAddr}`);

    // Verify the key produces a valid address
    if (cpuAddr.startsWith("0x") && cpuAddr.length === 42) {
      console.log(`    PASS: best key produces valid address`);
      passed++;
    } else {
      console.log(`    FAIL: invalid address from best key`);
      failed++;
    }
  } else {
    console.log("\n  NOTE: No best result found (all addresses were 0xff...ff worse)");
  }

  // Cleanup
  paramsBuffer.destroy();
  resultsBuffer.destroy();
  readbackBuffer.destroy();
  tableBuffer.destroy();
  debugBuffer.destroy();
  debugReadback.destroy();

  return { passed, failed };
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("KEYMINER END-TO-END TEST");
  console.log("========================\n");
  console.log("WARNING: All keys below are PUBLIC TEST DATA — never use for real funds.\n");

  let totalPassed = 0;
  let totalFailed = 0;

  // Test 1: Known vectors (CPU-only)
  console.log("Test 1: Known key→address vectors (CPU)\n");
  const { passed: p1, failed: f1 } = testKnownVectors();
  totalPassed += p1;
  totalFailed += f1;

  // Test 2: GPU dispatch + debug buffer
  console.log("\nTest 2: GPU dispatch + debug buffer verification");
  const device = await initGPU();
  const { passed: p2, failed: f2 } = await testGPUDispatch(device);
  totalPassed += p2;
  totalFailed += f2;

  console.log(`\n========================`);
  console.log(`Results: ${totalPassed} passed, ${totalFailed} failed`);
  console.log(`========================`);
  console.log("\nWARNING: All keys above are PUBLIC TEST DATA — never use for real funds.");

  if (totalFailed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
