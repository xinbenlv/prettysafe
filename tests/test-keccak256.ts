#!/usr/bin/env bun
/**
 * GPU test harness for wgsl/keccak256.wgsl
 *
 * Hashes 64-byte inputs on GPU, reads results back, and compares
 * against ethers.js keccak256 reference.
 *
 * Test cases:
 * - Known pubkey → keccak hash (from ethers.js SigningKey)
 * - All-zero input
 * - All-0xFF input
 * - Multiple parallel inputs (cross-thread contamination check)
 */

import { keccak256, SigningKey } from "ethers";

// ── Helpers ─────────────────────────────────────────────────────────

function hexToU32Array(hex: string): Uint32Array {
  const clean = hex.replace("0x", "").padStart(64, "0");
  // Big-endian: hex[0..7] → u32[0], hex[8..15] → u32[1], etc.
  const result = new Uint32Array(clean.length / 8);
  for (let i = 0; i < result.length; i++) {
    result[i] = parseInt(clean.slice(i * 8, i * 8 + 8), 16) >>> 0;
  }
  return result;
}

function u32ArrayToHex(arr: Uint32Array, offset: number, len: number): string {
  let hex = "0x";
  for (let i = 0; i < len; i++) {
    hex += (arr[offset + i] >>> 0).toString(16).padStart(8, "0");
  }
  return hex;
}

// Convert 8 LE u32s from GPU output → 32-byte hex
// GPU keccak output is in native LE lane order: [lo0, hi0, lo1, hi1, lo2, hi2, lo3, hi3]
// Each pair (lo, hi) is a 64-bit lane in LE byte order.
// Need to reconstruct the 32-byte hash in standard byte order.
function gpuKeccakOutputToHex(arr: Uint32Array, offset: number): string {
  let hex = "0x";
  for (let i = 0; i < 4; i++) {
    const lo = arr[offset + i * 2];
    const hi = arr[offset + i * 2 + 1];
    // Each lane is 8 bytes in LE order: lo bytes [0..3], hi bytes [4..7]
    for (const word of [lo, hi]) {
      hex += (word & 0xFF).toString(16).padStart(2, "0");
      hex += ((word >> 8) & 0xFF).toString(16).padStart(2, "0");
      hex += ((word >> 16) & 0xFF).toString(16).padStart(2, "0");
      hex += ((word >> 24) & 0xFF).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

// ── Reference: CPU keccak256 of 64 bytes ────────────────────────────

// ethers.keccak256 takes bytes, so we need to convert 16 big-endian u32s → bytes
function referencKeccak64(inputU32sBE: Uint32Array): string {
  const bytes = new Uint8Array(64);
  for (let i = 0; i < 16; i++) {
    const w = inputU32sBE[i];
    bytes[i * 4] = (w >> 24) & 0xFF;
    bytes[i * 4 + 1] = (w >> 16) & 0xFF;
    bytes[i * 4 + 2] = (w >> 8) & 0xFF;
    bytes[i * 4 + 3] = w & 0xFF;
  }
  return keccak256(bytes);
}

// ── Build test shader ───────────────────────────────────────────────

function buildTestShader(keccakWgsl: string): string {
  return keccakWgsl + `

@group(0) @binding(0) var<storage, read> inputs: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputs: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    let in_base = idx * 16u;
    let out_base = idx * 8u;

    var input: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) {
        input[i] = inputs[in_base + i];
    }

    let hash = keccak256_64(input);

    for (var i = 0u; i < 8u; i++) {
        outputs[out_base + i] = hash[i];
    }
}
`;
}

// ── WebGPU setup ────────────────────────────────────────────────────

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

interface TestCase {
  inputU32s: Uint32Array; // 16 big-endian u32s = 64 bytes
  expectedHash: string;   // 0x-prefixed 64-char hex
  label: string;
}

async function runTests(device: GPUDevice, cases: TestCase[]): Promise<{ passed: number; failed: number }> {
  const keccakWgsl = await Bun.file(new URL("../wgsl/keccak256.wgsl", import.meta.url).pathname).text();
  const shaderCode = buildTestShader(keccakWgsl);
  const shaderModule = device.createShaderModule({ code: shaderCode });

  const inputData = new Uint32Array(cases.length * 16);
  for (let i = 0; i < cases.length; i++) {
    for (let j = 0; j < 16; j++) {
      inputData[i * 16 + j] = cases[i].inputU32s[j];
    }
  }

  const inputBuffer = device.createBuffer({
    size: inputData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, inputData);

  const outputSize = cases.length * 8 * 4;
  const outputBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });
  const readbackBuffer = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });

  const pipeline = device.createComputePipeline({
    layout: "auto",
    compute: { module: shaderModule, entryPoint: "main" },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: inputBuffer } },
      { binding: 1, resource: { buffer: outputBuffer } },
    ],
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(cases.length);
  pass.end();
  encoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, outputSize);
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
  readbackBuffer.unmap();

  let passed = 0;
  let failed = 0;

  for (let i = 0; i < cases.length; i++) {
    const gotHex = gpuKeccakOutputToHex(resultData, i * 8);
    const expected = cases[i].expectedHash.toLowerCase();
    if (gotHex.toLowerCase() === expected) {
      passed++;
      console.log(`  PASS: ${cases[i].label}`);
    } else {
      console.log(`  FAIL: ${cases[i].label}`);
      console.log(`    expected: ${expected}`);
      console.log(`    got:      ${gotHex}`);
      failed++;
    }
  }

  inputBuffer.destroy();
  outputBuffer.destroy();
  readbackBuffer.destroy();

  return { passed, failed };
}

// ── Build test cases ────────────────────────────────────────────────

function buildTestCases(): TestCase[] {
  const cases: TestCase[] = [];

  // 1. All-zero 64-byte input
  {
    const input = new Uint32Array(16);
    cases.push({
      inputU32s: input,
      expectedHash: referencKeccak64(input),
      label: "all-zero 64 bytes",
    });
  }

  // 2. All-0xFF 64-byte input
  {
    const input = new Uint32Array(16);
    input.fill(0xFFFFFFFF);
    cases.push({
      inputU32s: input,
      expectedHash: referencKeccak64(input),
      label: "all-0xFF 64 bytes",
    });
  }

  // 3. Known private key → pubkey → keccak
  const testKeys = [
    "0x0000000000000000000000000000000000000000000000000000000000000001",
    "0x0000000000000000000000000000000000000000000000000000000000000002",
    "0x0000000000000000000000000000000000000000000000000000000000000003",
    "0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364140", // n-1
  ];

  for (const keyHex of testKeys) {
    const sk = new SigningKey(keyHex);
    const pub = sk.publicKey; // 0x04 + 64hex_x + 64hex_y
    const x = pub.slice(4, 68);
    const y = pub.slice(68, 132);

    // Convert to 16 big-endian u32s (x[0..7] then y[0..7])
    const input = new Uint32Array(16);
    for (let i = 0; i < 8; i++) {
      input[i] = parseInt(x.slice(i * 8, i * 8 + 8), 16) >>> 0;
      input[8 + i] = parseInt(y.slice(i * 8, i * 8 + 8), 16) >>> 0;
    }

    const expected = referencKeccak64(input);

    cases.push({
      inputU32s: input,
      expectedHash: expected,
      label: `pubkey(${keyHex.slice(0, 10)}...)`,
    });
  }

  // 4. Random 64-byte inputs
  for (let i = 0; i < 4; i++) {
    const input = new Uint32Array(16);
    const bytes = crypto.getRandomValues(new Uint8Array(64));
    for (let j = 0; j < 16; j++) {
      input[j] = (bytes[j * 4] << 24) | (bytes[j * 4 + 1] << 16) |
                 (bytes[j * 4 + 2] << 8) | bytes[j * 4 + 3];
    }
    cases.push({
      inputU32s: input,
      expectedHash: referencKeccak64(input),
      label: `random${i}`,
    });
  }

  return cases;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("test-keccak256: GPU Keccak-256 tests\n");

  const device = await initGPU();
  console.log("GPU initialized.\n");

  const cases = buildTestCases();
  console.log(`Running ${cases.length} test cases on GPU...\n`);

  const { passed, failed } = await runTests(device, cases);

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${cases.length} tests`);

  if (failed > 0) {
    process.exit(1);
  }

  // ── Cross-thread contamination check ──────────────────────────
  console.log("\nRunning parallel dispatch (cross-thread contamination check)...");
  // Re-run all cases in a single dispatch with multiple workgroups
  const { passed: p2, failed: f2 } = await runTests(device, cases);
  console.log(`  ${p2} passed, ${f2} failed`);
  if (f2 > 0) process.exit(1);

  console.log("\nAll Keccak-256 tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
