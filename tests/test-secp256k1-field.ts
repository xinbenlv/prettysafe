#!/usr/bin/env bun
/**
 * GPU test harness for wgsl/secp256k1-field.wgsl
 *
 * Runs field operations on GPU, reads results back, and compares
 * against BigInt reference implementation.
 *
 * Operations tested: mod_add, mod_sub, mod_mul, mod_sqr, mod_inv
 * Edge cases: a=0, a=1, a=p-1, near-overflow
 */

const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;

// ── BigInt reference ────────────────────────────────────────────────

function modAdd(a: bigint, b: bigint): bigint { return (a + b) % P; }
function modSub(a: bigint, b: bigint): bigint { return ((a - b) % P + P) % P; }
function modMul(a: bigint, b: bigint): bigint { return (a * b) % P; }
function modSqr(a: bigint): bigint { return (a * a) % P; }
function modInv(a: bigint): bigint { return modPow(a, P - 2n, P); }

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let result = 1n;
  base = base % mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

// ── Limb conversion ─────────────────────────────────────────────────

function bigintToLimbs(n: bigint): Uint32Array {
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    limbs[i] = Number(n & 0xFFFFFFFFn) >>> 0;
    n >>= 32n;
  }
  return limbs;
}

function limbsToBigint(limbs: Uint32Array, offset = 0): bigint {
  let result = 0n;
  for (let i = 7; i >= 0; i--) {
    result = (result << 32n) | BigInt(limbs[offset + i] >>> 0);
  }
  return result;
}

function randomFieldElement(): bigint {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n % P;
}

// ── Test shader ─────────────────────────────────────────────────────

// Op codes for the test shader
const OP_MOD_ADD = 0;
const OP_MOD_SUB = 1;
const OP_MOD_MUL = 2;
const OP_MOD_SQR = 3;
const OP_MOD_INV = 4;

function buildTestShader(fieldWgsl: string): string {
  // Test shader: each thread reads (op, a, b) from input, writes result to output
  return fieldWgsl + `

@group(0) @binding(0) var<storage, read> inputs: array<u32>;
@group(0) @binding(1) var<storage, read_write> outputs: array<u32>;

fn load_u256(offset: u32) -> array<u32, 8> {
    var r: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { r[i] = inputs[offset + i]; }
    return r;
}

fn store_u256(offset: u32, val: array<u32, 8>) {
    for (var i = 0u; i < 8u; i++) { outputs[offset + i] = val[i]; }
}

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let idx = gid.x;
    // Each test case: 1 u32 op + 8 u32 a + 8 u32 b = 17 u32s input
    // Output: 8 u32s per test case
    let in_base = idx * 17u;
    let out_base = idx * 8u;

    let op = inputs[in_base];
    let a = load_u256(in_base + 1u);
    let b = load_u256(in_base + 9u);

    var result: array<u32, 8>;
    if (op == 0u) {
        result = mod_add(a, b);
    } else if (op == 1u) {
        result = mod_sub(a, b);
    } else if (op == 2u) {
        result = mod_mul(a, b);
    } else if (op == 3u) {
        result = mod_sqr(a); // b ignored for sqr
    } else if (op == 4u) {
        result = mod_inv(a);    // b ignored for inv
    }

    store_u256(out_base, result);
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
  op: number;
  a: bigint;
  b: bigint;
  label: string;
  expected: bigint;
}

async function runTests(device: GPUDevice, cases: TestCase[]): Promise<{ passed: number; failed: number }> {
  const fieldWgsl = await Bun.file(new URL("../wgsl/secp256k1-field.wgsl", import.meta.url).pathname).text();

  // Fix: mod_sqr takes one argument but our shader calls it with two — shader uses b as dummy
  const shaderCode = buildTestShader(fieldWgsl);
  const shaderModule = device.createShaderModule({ code: shaderCode });

  const INPUT_STRIDE = 17; // 1 op + 8 a + 8 b
  const OUTPUT_STRIDE = 8;

  const inputData = new Uint32Array(cases.length * INPUT_STRIDE);
  for (let i = 0; i < cases.length; i++) {
    const base = i * INPUT_STRIDE;
    inputData[base] = cases[i].op;
    const aLimbs = bigintToLimbs(cases[i].a);
    const bLimbs = bigintToLimbs(cases[i].b);
    for (let j = 0; j < 8; j++) {
      inputData[base + 1 + j] = aLimbs[j];
      inputData[base + 9 + j] = bLimbs[j];
    }
  }

  const inputBuffer = device.createBuffer({
    size: inputData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(inputBuffer, 0, inputData);

  const outputSize = cases.length * OUTPUT_STRIDE * 4;
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
    const got = limbsToBigint(resultData, i * OUTPUT_STRIDE);
    const expected = cases[i].expected;
    if (got === expected) {
      passed++;
    } else {
      console.log(`  FAIL: ${cases[i].label}`);
      console.log(`    a:        0x${cases[i].a.toString(16)}`);
      console.log(`    b:        0x${cases[i].b.toString(16)}`);
      console.log(`    expected: 0x${expected.toString(16)}`);
      console.log(`    got:      0x${got.toString(16)}`);
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

  // Helper to add a case
  const add = (op: number, a: bigint, b: bigint, label: string) => {
    let expected: bigint;
    switch (op) {
      case OP_MOD_ADD: expected = modAdd(a, b); break;
      case OP_MOD_SUB: expected = modSub(a, b); break;
      case OP_MOD_MUL: expected = modMul(a, b); break;
      case OP_MOD_SQR: expected = modSqr(a); break;
      case OP_MOD_INV: expected = modInv(a); break;
      default: throw new Error(`Unknown op: ${op}`);
    }
    cases.push({ op, a, b, label, expected });
  };

  // ── mod_add ────────────────────────────────────────────────
  add(OP_MOD_ADD, 0n, 0n, "add(0, 0)");
  add(OP_MOD_ADD, 1n, 1n, "add(1, 1)");
  add(OP_MOD_ADD, P - 1n, 1n, "add(p-1, 1) → wrap");
  add(OP_MOD_ADD, P - 1n, P - 1n, "add(p-1, p-1) → wrap");
  for (let i = 0; i < 5; i++) {
    const a = randomFieldElement();
    const b = randomFieldElement();
    add(OP_MOD_ADD, a, b, `add(rand${i})`);
  }

  // ── mod_sub ────────────────────────────────────────────────
  add(OP_MOD_SUB, 0n, 0n, "sub(0, 0)");
  add(OP_MOD_SUB, 1n, 0n, "sub(1, 0)");
  add(OP_MOD_SUB, 0n, 1n, "sub(0, 1) → wrap");
  add(OP_MOD_SUB, P - 1n, P - 1n, "sub(p-1, p-1)");
  for (let i = 0; i < 5; i++) {
    const a = randomFieldElement();
    const b = randomFieldElement();
    add(OP_MOD_SUB, a, b, `sub(rand${i})`);
  }

  // ── mod_mul ────────────────────────────────────────────────
  add(OP_MOD_MUL, 0n, 1n, "mul(0, 1)");
  add(OP_MOD_MUL, 1n, 1n, "mul(1, 1)");
  add(OP_MOD_MUL, P - 1n, P - 1n, "mul(p-1, p-1)");
  add(OP_MOD_MUL, 2n, 3n, "mul(2, 3)");
  add(OP_MOD_MUL, P - 1n, 2n, "mul(p-1, 2)");
  for (let i = 0; i < 5; i++) {
    const a = randomFieldElement();
    const b = randomFieldElement();
    add(OP_MOD_MUL, a, b, `mul(rand${i})`);
  }

  // ── mod_sqr ────────────────────────────────────────────────
  add(OP_MOD_SQR, 0n, 0n, "sqr(0)");
  add(OP_MOD_SQR, 1n, 0n, "sqr(1)");
  add(OP_MOD_SQR, 2n, 0n, "sqr(2)");
  add(OP_MOD_SQR, P - 1n, 0n, "sqr(p-1)");
  for (let i = 0; i < 5; i++) {
    const a = randomFieldElement();
    add(OP_MOD_SQR, a, 0n, `sqr(rand${i})`);
  }

  // ── mod_inv ────────────────────────────────────────────────
  add(OP_MOD_INV, 1n, 0n, "inv(1) = 1");
  add(OP_MOD_INV, 2n, 0n, "inv(2)");
  add(OP_MOD_INV, P - 1n, 0n, "inv(p-1)");
  for (let i = 0; i < 5; i++) {
    const a = randomFieldElement();
    if (a === 0n) continue; // skip zero
    add(OP_MOD_INV, a, 0n, `inv(rand${i})`);
  }

  return cases;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log("test-secp256k1-field: GPU field arithmetic tests\n");

  const device = await initGPU();
  console.log("GPU initialized.\n");

  const cases = buildTestCases();
  console.log(`Running ${cases.length} test cases on GPU...\n`);

  const { passed, failed } = await runTests(device, cases);

  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${cases.length} tests`);

  if (failed > 0) {
    process.exit(1);
  }

  // ── Verify mod_inv identity: inv(a) * a == 1 ──────────────────
  console.log("\nRunning mod_inv identity checks (inv(a) * a == 1)...");
  const invCases: TestCase[] = [];
  for (let i = 0; i < 8; i++) {
    const a = randomFieldElement();
    if (a === 0n) continue;
    const invA = modInv(a);
    invCases.push({
      op: OP_MOD_MUL,
      a: invA,
      b: a,
      label: `inv_identity(rand${i})`,
      expected: 1n,
    });
  }

  const inv = await runTests(device, invCases);
  console.log(`  ${inv.passed} passed, ${inv.failed} failed`);
  if (inv.failed > 0) process.exit(1);

  console.log("\nAll field arithmetic tests passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
