#!/usr/bin/env bun
/**
 * GPU test harness for wgsl/secp256k1-ec.wgsl
 *
 * Runs scalar * G on GPU, reads affine pubkey back, and compares
 * against ethers.js SigningKey.
 *
 * Test cases:
 * - 1*G, 2*G, small known scalars
 * - Large random scalars
 * - Scalars near curve order
 */

import { SigningKey } from "ethers";

// ── Limb conversion ─────────────────────────────────────────────────

function bigintToLimbs(n: bigint): Uint32Array {
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    limbs[i] = Number(n & 0xFFFFFFFFn) >>> 0;
    n >>= 32n;
  }
  return limbs;
}

function bigintToHex64(n: bigint): string {
  return "0x" + n.toString(16).padStart(64, "0");
}

// Parse pubkey from ethers SigningKey → { x: 32-byte hex, y: 32-byte hex }
function getPubkey(scalar: bigint): { x: string; y: string } {
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const s = ((scalar % n) + n) % n;
  const sk = new SigningKey(bigintToHex64(s));
  const pub = sk.publicKey; // "0x04" + 64hex_x + 64hex_y
  return {
    x: "0x" + pub.slice(4, 68),
    y: "0x" + pub.slice(68, 132),
  };
}

// ── Build test shader ───────────────────────────────────────────────

function buildTestShader(fieldWgsl: string, keccakWgsl: string, ecWgsl: string): string {
  // Test shader: each thread reads a scalar, computes scalar*G, writes affine pubkey
  return fieldWgsl + "\n" + keccakWgsl + "\n" + ecWgsl + `

@group(0) @binding(0) var<storage, read> inputs: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputs: array<u32>;

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    let in_base = idx * 8u;
    let out_base = idx * 16u;

    var scalar: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { scalar[i] = inputs[in_base + i]; }

    let pt = ec_mul(scalar);
    let affine = ec_to_affine(pt);

    for (var i = 0u; i < 16u; i++) {
        outputs[out_base + i] = affine[i];
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
  scalar: bigint;
  expectedX: string; // 0x-prefixed 64-char hex
  expectedY: string;
  label: string;
}

async function runTests(device: GPUDevice, cases: TestCase[]): Promise<{ passed: number; failed: number }> {
  const fieldWgsl = await Bun.file(new URL("../wgsl/secp256k1-field.wgsl", import.meta.url).pathname).text();
  const keccakWgsl = await Bun.file(new URL("../wgsl/keccak256.wgsl", import.meta.url).pathname).text();
  const ecWgsl = await Bun.file(new URL("../wgsl/secp256k1-ec.wgsl", import.meta.url).pathname).text();
  const shaderCode = buildTestShader(fieldWgsl, keccakWgsl, ecWgsl);
  const shaderModule = device.createShaderModule({ code: shaderCode });

  const inputData = new Uint32Array(cases.length * 8);
  for (let i = 0; i < cases.length; i++) {
    const limbs = bigintToLimbs(cases[i].scalar);
    for (let j = 0; j < 8; j++) {
      inputData[i * 8 + j] = limbs[j];
    }
  }

  const inputBuffer = device.createBuffer({
    size: inputData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, inputData);

  const outputSize = cases.length * 16 * 4;
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
    const base = i * 16;
    // ec_to_affine outputs big-endian u32 values (MSByte in high bits of u32).
    // Read each u32 value directly as 8-char hex.
    let gotX = "0x";
    let gotY = "0x";
    for (let j = 0; j < 8; j++) {
      gotX += (resultData[base + j] >>> 0).toString(16).padStart(8, "0");
      gotY += (resultData[base + 8 + j] >>> 0).toString(16).padStart(8, "0");
    }

    const expectedX = cases[i].expectedX.toLowerCase();
    const expectedY = cases[i].expectedY.toLowerCase();
    gotX = gotX.toLowerCase();
    gotY = gotY.toLowerCase();

    if (gotX === expectedX && gotY === expectedY) {
      passed++;
      console.log(`  PASS: ${cases[i].label}`);
    } else {
      console.log(`  FAIL: ${cases[i].label}`);
      if (gotX !== expectedX) {
        console.log(`    x expected: ${expectedX}`);
        console.log(`    x got:      ${gotX}`);
      }
      if (gotY !== expectedY) {
        console.log(`    y expected: ${expectedY}`);
        console.log(`    y got:      ${gotY}`);
      }
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

  // Small known scalars
  const smallScalars = [1n, 2n, 3n, 7n, 10n, 100n, 256n, 65536n, 0xDEADBEEFn];
  for (const s of smallScalars) {
    const pub = getPubkey(s);
    cases.push({
      scalar: s,
      expectedX: pub.x,
      expectedY: pub.y,
      label: `${s}*G`,
    });
  }

  // Large known scalars
  const largeScalars = [
    0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364140n, // n-1
    0x1234567890ABCDEFn,
    0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFn,
  ];
  for (const s of largeScalars) {
    const pub = getPubkey(s);
    cases.push({
      scalar: s,
      expectedX: pub.x,
      expectedY: pub.y,
      label: `0x${s.toString(16).slice(0, 12)}...*G`,
    });
  }

  // Random scalars
  for (let i = 0; i < 5; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    let s = 0n;
    for (const b of bytes) s = (s << 8n) | BigInt(b);
    // Reduce mod n to ensure valid
    const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    s = (s % (n - 1n)) + 1n; // ensure non-zero
    const pub = getPubkey(s);
    cases.push({
      scalar: s,
      expectedX: pub.x,
      expectedY: pub.y,
      label: `random${i} (0x${s.toString(16).slice(0, 8)}...)`,
    });
  }

  return cases;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("test-secp256k1-ec: GPU EC point multiplication tests\n");

  const device = await initGPU();
  console.log("GPU initialized.\n");

  const cases = buildTestCases();
  console.log(`Running ${cases.length} test cases on GPU...\n`);

  const { passed, failed } = await runTests(device, cases);

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${cases.length} tests`);

  if (failed > 0) {
    process.exit(1);
  }

  console.log("\nAll EC point multiplication tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
