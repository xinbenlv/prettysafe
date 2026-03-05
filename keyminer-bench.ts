#!/usr/bin/env bun
/**
 * Quick benchmark for keyminer GPU pipeline.
 * Runs dispatches for ~5 seconds and reports rate.
 */
import { join } from "path";
import { SigningKey } from "ethers";

function hexToLimbs(hex: string): Uint32Array {
  const clean = hex.replace("0x", "").padStart(64, "0");
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const byteOffset = (7 - i) * 8;
    limbs[i] = parseInt(clean.slice(byteOffset, byteOffset + 8), 16) >>> 0;
  }
  return limbs;
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

// WebGPU init
let adapter: GPUAdapter | null = null;
const mod = await import("bun-webgpu");
// @ts-ignore
if (mod.setupGlobals) mod.setupGlobals();
// @ts-ignore
if (mod.createGPUInstance) {
  // @ts-ignore
  const gpu = mod.createGPUInstance();
  adapter = await gpu.requestAdapter();
}
if (!adapter) throw new Error("No WebGPU adapter");
const device = await adapter.requestDevice();
console.log(`GPU: ${adapter.info.vendor} ${adapter.info.architecture}`);

// Dispatch config
const WORKGROUP_SIZE = 64;
const TABLE_A_SIZE = 64;
const TABLE_B_SIZE = 1024;
const TABLE_C_SIZE = 16;
const DISPATCH_X = TABLE_B_SIZE;
const DISPATCH_Y = TABLE_C_SIZE;
const ITEMS_PER_DISPATCH = WORKGROUP_SIZE * DISPATCH_X * DISPATCH_Y;

// Precompute table
const TABLE_TOTAL = TABLE_A_SIZE + TABLE_B_SIZE + TABLE_C_SIZE;
const tableData = new Uint32Array(TABLE_TOTAL * 16);

function writePointToTable(idx: number, pt: { x: Uint32Array; y: Uint32Array } | null) {
  const base = idx * 16;
  if (pt === null) {
    for (let i = 0; i < 16; i++) tableData[base + i] = 0;
  } else {
    for (let i = 0; i < 8; i++) tableData[base + i] = pt.x[i];
    for (let i = 0; i < 8; i++) tableData[base + 8 + i] = pt.y[i];
  }
}

console.log("Precomputing EC table...");
for (let i = 0; i < TABLE_A_SIZE; i++) writePointToTable(i, computeECPoint(BigInt(i)));
for (let i = 0; i < TABLE_B_SIZE; i++) writePointToTable(TABLE_A_SIZE + i, computeECPoint(BigInt(i) * 64n));
for (let i = 0; i < TABLE_C_SIZE; i++) writePointToTable(TABLE_A_SIZE + TABLE_B_SIZE + i, computeECPoint(BigInt(i) * 65536n));

// Shader
const shaderCode = [
  await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-field.wgsl")).text(),
  await Bun.file(join(import.meta.dir, "wgsl", "keccak256.wgsl")).text(),
  await Bun.file(join(import.meta.dir, "wgsl", "secp256k1-ec.wgsl")).text(),
  await Bun.file(join(import.meta.dir, "keyminer.wgsl")).text(),
].join("\n");

const shaderModule = device.createShaderModule({ code: shaderCode });

const PARAMS_SIZE = 96;
const paramsBuffer = device.createBuffer({ size: PARAMS_SIZE, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const RESULTS_SIZE = 56;
const resultsBuffer = device.createBuffer({ size: RESULTS_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
const readbackBuffer = device.createBuffer({ size: RESULTS_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const tableBuffer = device.createBuffer({ size: tableData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(tableBuffer, 0, tableData);
const DEBUG_SIZE = 32 * 4;
const debugBuffer = device.createBuffer({ size: DEBUG_SIZE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });

const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: shaderModule, entryPoint: "main" } });
const bindGroup = device.createBindGroup({
  layout: pipeline.getBindGroupLayout(0),
  entries: [
    { binding: 0, resource: { buffer: paramsBuffer } },
    { binding: 1, resource: { buffer: resultsBuffer } },
    { binding: 2, resource: { buffer: tableBuffer } },
    { binding: 3, resource: { buffer: debugBuffer } },
  ],
});

const startKeyBigInt = 0xdeadbeefcafebabe0123456789abcdefn;

// Pre-allocate reusable arrays
const initResults = new Uint32Array(14);
initResults.fill(0xffffffff);
initResults[13] = 0;
const paramsData = new Uint32Array(24);

async function runDispatch(offset: number) {
  device.queue.writeBuffer(resultsBuffer, 0, initResults);

  const baseScalar = startKeyBigInt + BigInt(offset);
  const basePoint = computeECPoint(baseScalar)!;
  paramsData.fill(0);
  for (let i = 0; i < 8; i++) paramsData[i] = basePoint.x[i];
  for (let i = 0; i < 8; i++) paramsData[8 + i] = basePoint.y[i];
  const scalarLimbs = hexToLimbs(bigintToHex64(baseScalar));
  for (let i = 0; i < 8; i++) paramsData[16 + i] = scalarLimbs[i];
  device.queue.writeBuffer(paramsBuffer, 0, paramsData);

  const commandEncoder = device.createCommandEncoder();
  const pass = commandEncoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(DISPATCH_X, DISPATCH_Y);
  pass.end();
  commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, RESULTS_SIZE);
  device.queue.submit([commandEncoder.finish()]);

  await readbackBuffer.mapAsync(GPUMapMode.READ);
  readbackBuffer.getMappedRange();
  readbackBuffer.unmap();
}

// Warmup
console.log("Warming up (2s)...");
let offset = 0;
let warmupIter = 0;
const warmupStart = performance.now();
while (performance.now() - warmupStart < 2000) {
  await runDispatch(offset);
  offset += ITEMS_PER_DISPATCH;
  warmupIter++;
}

// Benchmark (5s)
console.log("Benchmarking (5s)...");
let benchIter = 0;
const benchStart = performance.now();
while (performance.now() - benchStart < 5000) {
  await runDispatch(offset);
  offset += ITEMS_PER_DISPATCH;
  benchIter++;
}
const benchElapsed = (performance.now() - benchStart) / 1000;
const benchKeys = benchIter * ITEMS_PER_DISPATCH;
const rate = benchKeys / benchElapsed;

console.log(`\nResults:`);
console.log(`  Dispatches: ${benchIter}`);
console.log(`  Keys: ${(benchKeys / 1e6).toFixed(1)}M`);
console.log(`  Time: ${benchElapsed.toFixed(2)}s`);
console.log(`  Rate: ${(rate / 1e6).toFixed(2)} M keys/s`);
