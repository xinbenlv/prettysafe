#!/usr/bin/env bun
/**
 * Verify the full GPU mining pipeline against CPU:
 * private_key → public_key → keccak256 → address
 *
 * Runs one GPU dispatch with a known start key and checks every step.
 */

import { join } from "path";
import { Wallet, SigningKey, keccak256 as ethersKeccak } from "ethers";

function hexToLimbs(hex: string): Uint32Array {
  const clean = hex.replace("0x", "").padStart(64, "0");
  const limbs = new Uint32Array(8);
  for (let i = 0; i < 8; i++) {
    const off = (7 - i) * 8;
    limbs[i] = parseInt(clean.slice(off, off + 8), 16) >>> 0;
  }
  return limbs;
}

function limbsToHex(limbs: Uint32Array | number[], offset = 0, count = 8): string {
  let hex = "0x";
  for (let i = count - 1; i >= 0; i--) hex += (limbs[offset + i] >>> 0).toString(16).padStart(8, "0");
  return hex;
}

function bigintToHex64(n: bigint): string { return "0x" + n.toString(16).padStart(64, "0"); }

function computeECPoint(scalar: bigint) {
  const n = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
  const s = ((scalar % n) + n) % n;
  if (s === 0n) return null;
  const sk = new SigningKey(bigintToHex64(s));
  const pub = sk.publicKey;
  return { x: hexToLimbs("0x" + pub.slice(4, 68)), y: hexToLimbs("0x" + pub.slice(68, 132)) };
}

// GPU init
const mod = await import("bun-webgpu");
// @ts-ignore
if (mod.setupGlobals) mod.setupGlobals();
// @ts-ignore
const gpu = mod.createGPUInstance();
const adapter = await gpu.requestAdapter();
const device = await adapter!.requestDevice();

// Shader
const dir = join(import.meta.dir, "..");
const shaderCode = [
  await Bun.file(join(dir, "wgsl/secp256k1-field.wgsl")).text(),
  await Bun.file(join(dir, "wgsl/keccak256.wgsl")).text(),
  await Bun.file(join(dir, "wgsl/secp256k1-ec.wgsl")).text(),
  await Bun.file(join(dir, "keyminer.wgsl")).text(),
].join("\n");
const shaderModule = device.createShaderModule({ code: shaderCode });

// Table
const TABLE_A = 64, TABLE_B = 1024, TABLE_C = 16, TOTAL = TABLE_A + TABLE_B + TABLE_C;
const tableData = new Uint32Array(TOTAL * 16);
function writePoint(idx: number, pt: any) {
  const base = idx * 16;
  if (!pt) { for (let i = 0; i < 16; i++) tableData[base+i] = 0; return; }
  for (let i = 0; i < 8; i++) { tableData[base+i] = pt.x[i]; tableData[base+8+i] = pt.y[i]; }
}

const startKey = 12345n; // Known test scalar
console.log(`\n=== GPU Pipeline Verification ===`);
console.log(`Start key: ${bigintToHex64(startKey)}\n`);

// CPU reference for thread 0 (key = startKey)
const cpuWallet = new Wallet(bigintToHex64(startKey));
console.log(`CPU reference (thread 0, key=${startKey}):`);
console.log(`  address:  ${cpuWallet.address}`);
const cpuSk = new SigningKey(bigintToHex64(startKey));
const cpuPub = cpuSk.publicKey; // 0x04 + x + y
console.log(`  pubkey x: 0x${cpuPub.slice(4, 68)}`);
console.log(`  pubkey y: 0x${cpuPub.slice(68, 132)}`);

// CPU keccak of pubkey bytes
const pubBytes = "0x" + cpuPub.slice(4); // strip 0x04 prefix
const cpuHash = ethersKeccak(pubBytes);
console.log(`  keccak:   ${cpuHash}`);
console.log(`  addr from hash last 20 bytes: 0x${cpuHash.slice(26)}`);

// Precompute table
console.log(`\nPrecomputing EC table...`);
for (let i = 0; i < TABLE_A; i++) writePoint(i, computeECPoint(BigInt(i)));
for (let i = 0; i < TABLE_B; i++) writePoint(TABLE_A+i, computeECPoint(BigInt(i)*64n));
for (let i = 0; i < TABLE_C; i++) writePoint(TABLE_A+TABLE_B+i, computeECPoint(BigInt(i)*65536n));

// Buffers
const paramsBuffer = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
const resultsBuffer = device.createBuffer({ size: 56, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
const readback = device.createBuffer({ size: 56, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
const tableBuffer = device.createBuffer({ size: tableData.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
const debugBuffer = device.createBuffer({ size: 128, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
const debugReadback = device.createBuffer({ size: 128, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
device.queue.writeBuffer(tableBuffer, 0, tableData);

const pipeline = device.createComputePipeline({ layout: "auto", compute: { module: shaderModule, entryPoint: "main" } });
const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
  { binding: 0, resource: { buffer: paramsBuffer } },
  { binding: 1, resource: { buffer: resultsBuffer } },
  { binding: 2, resource: { buffer: tableBuffer } },
  { binding: 3, resource: { buffer: debugBuffer } },
]});

// Params: base_point = startKey * G, base_scalar = startKey
const basePoint = computeECPoint(startKey)!;
const paramsData = new Uint32Array(24);
for (let i = 0; i < 8; i++) { paramsData[i] = basePoint.x[i]; paramsData[8+i] = basePoint.y[i]; }
const scalarLimbs = hexToLimbs(bigintToHex64(startKey));
for (let i = 0; i < 8; i++) paramsData[16+i] = scalarLimbs[i];
device.queue.writeBuffer(paramsBuffer, 0, paramsData);

// Init results to 0xFF (worst possible address)
const initR = new Uint32Array(14); initR.fill(0xffffffff); initR[13] = 0;
device.queue.writeBuffer(resultsBuffer, 0, initR);
device.queue.writeBuffer(debugBuffer, 0, new Uint32Array(32));

// Dispatch just 1 workgroup to keep it simple
const enc = device.createCommandEncoder();
const pass = enc.beginComputePass();
pass.setPipeline(pipeline); pass.setBindGroup(0, bindGroup);
pass.dispatchWorkgroups(1, 1); // 64 threads only
pass.end();
enc.copyBufferToBuffer(resultsBuffer, 0, readback, 0, 56);
enc.copyBufferToBuffer(debugBuffer, 0, debugReadback, 0, 128);
device.queue.submit([enc.finish()]);
await device.queue.onSubmittedWorkDone();

await readback.mapAsync(GPUMapMode.READ);
const res = new Uint32Array(readback.getMappedRange().slice(0));
readback.unmap();

await debugReadback.mapAsync(GPUMapMode.READ);
const dbg = new Uint32Array(debugReadback.getMappedRange().slice(0));
debugReadback.unmap();

// === Verify thread 0 debug data ===
console.log(`\n=== GPU Debug Buffer (thread 0) ===`);

// Pubkey: dbg[0..15] — ec_to_affine output, big-endian u32 values
let gpuPubX = "";
let gpuPubY = "";
for (let j = 0; j < 8; j++) {
  gpuPubX += (dbg[j] >>> 0).toString(16).padStart(8, "0");
  gpuPubY += (dbg[8 + j] >>> 0).toString(16).padStart(8, "0");
}
console.log(`  pubkey x: 0x${gpuPubX}`);
console.log(`  pubkey y: 0x${gpuPubY}`);
const pubXMatch = gpuPubX.toLowerCase() === cpuPub.slice(4, 68).toLowerCase();
const pubYMatch = gpuPubY.toLowerCase() === cpuPub.slice(68, 132).toLowerCase();
console.log(`  pubkey x match: ${pubXMatch}`);
console.log(`  pubkey y match: ${pubYMatch}`);

// Hash: dbg[16..23] — keccak256_64 output, 8 u32s in LE lane format
// The keccak output is: result[i*2] = state[i].x (lo), result[i*2+1] = state[i].y (hi)
// Each lane pair represents 8 bytes in LE order
const hashBytes = new Uint8Array(32);
for (let i = 0; i < 4; i++) {
  const lo = dbg[16 + i*2], hi = dbg[16 + i*2+1];
  hashBytes[i*8+0] = lo & 0xFF; hashBytes[i*8+1] = (lo>>8)&0xFF;
  hashBytes[i*8+2] = (lo>>16)&0xFF; hashBytes[i*8+3] = (lo>>24)&0xFF;
  hashBytes[i*8+4] = hi & 0xFF; hashBytes[i*8+5] = (hi>>8)&0xFF;
  hashBytes[i*8+6] = (hi>>16)&0xFF; hashBytes[i*8+7] = (hi>>24)&0xFF;
}
const gpuHashHex = "0x" + Array.from(hashBytes).map(b => b.toString(16).padStart(2,"0")).join("");
console.log(`  keccak:   ${gpuHashHex}`);
console.log(`  keccak match: ${gpuHashHex.toLowerCase() === cpuHash.toLowerCase()}`);

// Address from hash last 20 bytes
const gpuAddr = "0x" + Array.from(hashBytes.slice(12)).map(b => b.toString(16).padStart(2,"0")).join("");
console.log(`  address:  ${gpuAddr}`);
console.log(`  address match: ${gpuAddr.toLowerCase() === cpuWallet.address.toLowerCase()}`);

// Key: dbg[24..31] — private key in u256 LE limb format
const gpuKeyHex = limbsToHex(Array.from(dbg.slice(24, 32)));
console.log(`  key:      ${gpuKeyHex}`);
console.log(`  key match: ${gpuKeyHex.toLowerCase() === bigintToHex64(startKey).toLowerCase()}`);

// === Verify best result ===
console.log(`\n=== Best Result from GPU ===`);
const found = res[13];
console.log(`  found flag: ${found}`);
if (found === 1) {
  const gpuBestKeyHex = limbsToHex(Array.from(res.slice(5, 13)));
  console.log(`  best key: ${gpuBestKeyHex}`);
  const cpuBestWallet = new Wallet(gpuBestKeyHex);
  console.log(`  CPU addr from best key: ${cpuBestWallet.address}`);

  // GPU address from result addr words — these are hash[3..7] in keccak LE lane format
  // addr_is_smaller compares swap_endian of these words
  // To reconstruct hex address, extract bytes in LE order from each u32
  let gpuBestAddr = "0x";
  for (let i = 0; i < 5; i++) {
    const w = res[i];
    gpuBestAddr += (w & 0xFF).toString(16).padStart(2, "0");
    gpuBestAddr += ((w >> 8) & 0xFF).toString(16).padStart(2, "0");
    gpuBestAddr += ((w >> 16) & 0xFF).toString(16).padStart(2, "0");
    gpuBestAddr += ((w >> 24) & 0xFF).toString(16).padStart(2, "0");
  }
  console.log(`  GPU addr (from result): ${gpuBestAddr}`);
  console.log(`  CPU vs GPU addr match: ${cpuBestWallet.address.toLowerCase() === gpuBestAddr.toLowerCase()}`);

  const clean = cpuBestWallet.address.replace("0x","").toLowerCase();
  let zeros = 0;
  for (const c of clean) { if (c === "0") zeros++; else break; }
  console.log(`  Leading zeros: ${zeros}`);
} else {
  console.log(`  No result found (found=0) — this is a bug!`);

  // Dump raw result words for debugging
  console.log(`  Raw result words:`);
  for (let i = 0; i < 14; i++) console.log(`    res[${i}] = 0x${(res[i]>>>0).toString(16).padStart(8,"0")}`);
}

// Also verify a few other threads (key = startKey + thread_id)
console.log(`\n=== Cross-check: CPU verify threads 1, 2, 63 ===`);
for (const tid of [1, 2, 63]) {
  const key = startKey + BigInt(tid);
  const w = new Wallet(bigintToHex64(key));
  const zeros = w.address.replace("0x","").toLowerCase().match(/^0*/)?.[0]?.length ?? 0;
  console.log(`  thread ${tid}: key=${bigintToHex64(key)} → ${w.address} (${zeros}z)`);
}

console.log(`\nDone.`);
