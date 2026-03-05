#!/usr/bin/env bun
/**
 * Exhaustive GPU-vs-CPU verification for a small batch of 1024 keys.
 *
 * Loads the PRODUCTION keyminer.wgsl and dynamically patches it to add
 * a per-thread output buffer (binding 4). This way the exact same EC,
 * keccak, table-lookup, and address-extraction logic is tested.
 *
 * Dispatches 1024 GPU threads (16 workgroups × 64 threads, gid.y=0),
 * reads back every thread's derived address and private key, then
 * verifies each one against ethers.js on CPU.
 *
 * WARNING: All private keys and addresses in this file are TEST-ONLY.
 *    They are PUBLIC TEST DATA — DO NOT send real funds to these addresses.
 */

import { join } from "path";
import { Wallet, SigningKey } from "ethers";

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

function limbsToHex(data: Uint32Array, offset: number, count: number): string {
  let hex = "0x";
  for (let i = count - 1; i >= 0; i--) {
    hex += (data[offset + i] >>> 0).toString(16).padStart(8, "0");
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

/** Convert GPU address words (keccak output, LE lanes) to hex address string */
function gpuAddrWordsToHex(data: Uint32Array, offset: number): string {
  let hex = "0x";
  for (let i = 0; i < 5; i++) {
    const w = data[offset + i];
    const swapped =
      ((w & 0xff) << 24) |
      (((w >> 8) & 0xff) << 16) |
      (((w >> 16) & 0xff) << 8) |
      ((w >> 24) & 0xff);
    hex += (swapped >>> 0).toString(16).padStart(8, "0");
  }
  return hex.toLowerCase();
}

// ── Shader patching ─────────────────────────────────────────────────

/**
 * Patch the production keyminer.wgsl to add a per-thread output buffer.
 * Two surgical insertions:
 *   1. Add @binding(4) verify_output buffer after @binding(3)
 *   2. Insert per-thread writes after key = u256_add_u32(key, thread_id);
 */
function patchShaderForVerify(src: string): string {
  // 1. Add verify_output binding after debug_buf binding
  const bindingAnchor = "@group(0) @binding(3) var<storage, read_write> debug_buf: array<u32>;";
  if (!src.includes(bindingAnchor)) {
    throw new Error("Could not find debug_buf binding in keyminer.wgsl — shader changed?");
  }
  src = src.replace(
    bindingAnchor,
    bindingAnchor + "\n@group(0) @binding(4) var<storage, read_write> verify_output: array<u32>;"
  );

  // 2. Insert per-thread output writes after key computation
  const keyAnchor = "key = u256_add_u32(key, thread_id);";
  if (!src.includes(keyAnchor)) {
    throw new Error("Could not find u256_add_u32 key line in keyminer.wgsl — shader changed?");
  }
  const outputWrites = `
    // [TEST PATCH] Write per-thread addr + key to verify_output
    {
        let vbase = thread_id * 13u;
        for (var vi = 0u; vi < 5u; vi = vi + 1u) { verify_output[vbase + vi] = addr[vi]; }
        for (var vi = 0u; vi < 8u; vi = vi + 1u) { verify_output[vbase + 5u + vi] = key[vi]; }
    }`;
  src = src.replace(keyAnchor, keyAnchor + outputWrites);

  return src;
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

// ── Constants ───────────────────────────────────────────────────────

const THREAD_COUNT = 1024;
const WORKGROUP_SIZE = 64;
const DISPATCH_X = THREAD_COUNT / WORKGROUP_SIZE; // 16 workgroups
const DISPATCH_Y = 1;
const WORDS_PER_THREAD = 13; // 5 addr + 8 key
const VERIFY_OUTPUT_SIZE = THREAD_COUNT * WORDS_PER_THREAD * 4; // 53,248 bytes

const TABLE_A_SIZE = 64;
const TABLE_B_SIZE = 1024;
const TABLE_C_SIZE = 16;
const TABLE_TOTAL = TABLE_A_SIZE + TABLE_B_SIZE + TABLE_C_SIZE;
const PARAMS_SIZE = 96;
const RESULTS_SIZE = 56;
const DEBUG_SIZE = 32 * 4;

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("KEYMINER EXHAUSTIVE GPU-vs-CPU VERIFICATION (1024 keys)");
  console.log("=======================================================");
  console.log("Tests the PRODUCTION keyminer.wgsl with a patched output buffer.\n");
  console.log("WARNING: All keys below are PUBLIC TEST DATA — never use for real funds.\n");

  const startKey = 0xabcdef0123456789n;
  const startKeyHex = bigintToHex64(startKey);
  console.log(`Start key: ${startKeyHex}`);
  console.log(`Threads:   ${THREAD_COUNT}`);
  console.log(`Dispatch:  ${DISPATCH_X} x ${DISPATCH_Y} (workgroup_size=64)\n`);

  // ── Load and patch production shader ────────────────────────────
  const baseDir = join(import.meta.dir, "..");
  const shaderSrc = [
    await Bun.file(join(baseDir, "wgsl", "secp256k1-field.wgsl")).text(),
    await Bun.file(join(baseDir, "wgsl", "keccak256.wgsl")).text(),
    await Bun.file(join(baseDir, "wgsl", "secp256k1-ec.wgsl")).text(),
    await Bun.file(join(baseDir, "keyminer.wgsl")).text(),
  ].join("\n");

  const patchedShader = patchShaderForVerify(shaderSrc);
  console.log("Loaded production keyminer.wgsl and applied test patch.");

  // ── GPU setup ───────────────────────────────────────────────────
  const device = await initGPU();
  const shaderModule = device.createShaderModule({ code: patchedShader });

  // Precompute EC table
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

  // Buffers (same as production + verify_output at binding 4)
  const paramsBuffer = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const resultsBuffer = device.createBuffer({ size: RESULTS_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const tableBuffer = device.createBuffer({ size: tableData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const debugBuffer = device.createBuffer({ size: DEBUG_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const verifyBuffer = device.createBuffer({ size: VERIFY_OUTPUT_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const readbackBuffer = device.createBuffer({ size: VERIFY_OUTPUT_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });

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
      { binding: 4, resource: { buffer: verifyBuffer } },
    ],
  });

  // Write params
  const basePoint = computeECPoint(startKey)!;
  const paramsData = new Uint32Array(24);
  for (let i = 0; i < 8; i++) paramsData[i] = basePoint.x[i];
  for (let i = 0; i < 8; i++) paramsData[8 + i] = basePoint.y[i];
  const scalarLimbs = hexToLimbs(startKeyHex);
  for (let i = 0; i < 8; i++) paramsData[16 + i] = scalarLimbs[i];
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  // Init results to 0xff (worst address)
  const initResults = new Uint32Array(14);
  initResults.fill(0xffffffff);
  initResults[13] = 0;
  device.queue.writeBuffer(resultsBuffer, 0, initResults);
  device.queue.writeBuffer(debugBuffer, 0, new Uint32Array(32));

  // ── Dispatch ────────────────────────────────────────────────────
  console.log("Running GPU dispatch...");
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(DISPATCH_X, DISPATCH_Y);
  pass.end();
  encoder.copyBufferToBuffer(verifyBuffer, 0, readbackBuffer, 0, VERIFY_OUTPUT_SIZE);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const gpuData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  console.log("GPU dispatch complete. Verifying all 1024 threads against CPU...\n");

  // ── Verify every thread ─────────────────────────────────────────
  let passed = 0;
  let failed = 0;
  const failures: string[] = [];

  for (let tid = 0; tid < THREAD_COUNT; tid++) {
    const base = tid * WORDS_PER_THREAD;
    const gpuKeyHex = limbsToHex(gpuData, base + 5, 8);
    const gpuAddrHex = gpuAddrWordsToHex(gpuData, base);

    // CPU reference
    const expectedKey = startKey + BigInt(tid);
    const expectedKeyHex = bigintToHex64(expectedKey);
    const wallet = new Wallet(expectedKeyHex);
    const cpuAddr = wallet.address.toLowerCase();

    const keyMatch = gpuKeyHex.toLowerCase() === expectedKeyHex.toLowerCase();
    const addrMatch = gpuAddrHex === cpuAddr;

    if (keyMatch && addrMatch) {
      passed++;
    } else {
      failed++;
      const msg = [
        `  thread ${tid}:`,
        !keyMatch ? `    key:  GPU=${gpuKeyHex}  CPU=${expectedKeyHex}` : null,
        !addrMatch ? `    addr: GPU=${gpuAddrHex}  CPU=${cpuAddr}` : null,
      ]
        .filter(Boolean)
        .join("\n");
      failures.push(msg);
      if (failures.length <= 10) console.log(msg);
    }
  }

  if (failures.length > 10) {
    console.log(`  ... and ${failures.length - 10} more failures\n`);
  }

  console.log("=======================================================");
  console.log(`Results: ${passed}/${THREAD_COUNT} passed, ${failed} failed`);
  console.log("=======================================================");
  console.log("\nWARNING: All keys above are PUBLIC TEST DATA — never use for real funds.");

  // Cleanup
  paramsBuffer.destroy();
  resultsBuffer.destroy();
  tableBuffer.destroy();
  debugBuffer.destroy();
  verifyBuffer.destroy();
  readbackBuffer.destroy();

  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
