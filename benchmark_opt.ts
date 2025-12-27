import { join } from "path";
import { parseArgs } from "util";

// Define arguments
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    sec: {
      type: 'string',
    },
    hash: {
      type: 'string',
    },
  },
  strict: true,
  allowPositionals: true,
});

async function main() {
  const targetSeconds = values.sec ? parseInt(values.sec) : 5;
  const targetHashes = values.hash ? parseInt(values.hash) : 0; // 0 means use seconds

  console.log("🚀 Initializing WebGPU Keccak256 Benchmark (Optimized)...");
  if (targetHashes > 0) {
      console.log(`🎯 Target: ${targetHashes} hashes`);
  } else {
      console.log(`⏱️  Target: ${targetSeconds} seconds`);
  }

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
      console.error("❌ Could not load bun-webgpu:", e);
      console.error("Please run `bun install` or ensure you are on a supported platform.");
      process.exit(1);
  }

  if (!adapter) {
      console.error("❌ No WebGPU Adapter found.");
      process.exit(1);
  }

  const device = await adapter.requestDevice();
  console.log(`💻 Using GPU: ${adapter.info.vendor} ${adapter.info.architecture}`);

  // Load Optimized WGSL shader
  const shaderCode = await Bun.file(join(import.meta.dir, "keccak_opt.wgsl")).text();
  const shaderModule = device.createShaderModule({ code: shaderCode });

  // Setup Buffers
  const templateState = new Uint32Array(50); // 200 bytes
  // Fill with random data
  for (let i = 0; i < 50; i++) templateState[i] = Math.floor(Math.random() * 0xFFFFFFFF);

  const templateBuffer = device.createBuffer({
    size: templateState.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(templateBuffer, 0, templateState);

  const paramsBufferSize = 16; // 4 u32s
  const paramsBuffer = device.createBuffer({
    size: paramsBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const solutionsBufferSize = 8; // 2 u32s
  const solutionsBuffer = device.createBuffer({
    size: solutionsBufferSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
  });

  // Pipeline
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    ],
  });

  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: shaderModule, entryPoint: "main" },
  });

  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: templateBuffer } },
      { binding: 1, resource: { buffer: paramsBuffer } },
      { binding: 2, resource: { buffer: solutionsBuffer } },
    ],
  });

  // Benchmark Loop
  const workgroupSize = 64; // Updated workgroup size
  const dispatchCount = 65535;
  const totalItemsPerDispatch = workgroupSize * dispatchCount;

  let totalHashesCalculated = 0;
  let iterations = 0;
  const startTime = performance.now();
  let currentTime = startTime;

  while (true) {
      // Check exit conditions
      if (targetHashes > 0) {
          if (totalHashesCalculated >= targetHashes) break;
      } else {
          if ((currentTime - startTime) / 1000 >= targetSeconds) break;
      }

      // Update Nonce High (simulate scan)
      const params = new Uint32Array([iterations, 0, 0, 0]);
      device.queue.writeBuffer(paramsBuffer, 0, params);

      const commandEncoder = device.createCommandEncoder();
      const passEncoder = commandEncoder.beginComputePass();
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.dispatchWorkgroups(dispatchCount);
      passEncoder.end();

      device.queue.submit([commandEncoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      totalHashesCalculated += totalItemsPerDispatch;
      iterations++;
      currentTime = performance.now();

      // Optional: Progress log every second
      if (iterations % 10 === 0) {
          process.stdout.write(`\rRunning... ${(currentTime - startTime).toFixed(0)}ms | ${(totalHashesCalculated / 1e6).toFixed(2)} MHashes`);
      }
  }
  console.log("\n");

  const durationSec = (currentTime - startTime) / 1000;
  const hashrate = totalHashesCalculated / durationSec;

  console.log(`📊 Results (Optimized):`);
  console.log(`   Duration: ${durationSec.toFixed(4)}s`);
  console.log(`   Total Hashes: ${totalHashesCalculated.toLocaleString()}`);
  console.log(`   Hashrate: ${(hashrate / 1_000_000).toFixed(2)} MH/s`);
}

main().catch(console.error);

