import { join } from "path";
import { ethers } from "ethers";
import { MAINNET_CREATE2_TESTCASES } from "./test-data.ts";

async function main() {
  console.log("🧪 Running WebGPU Create2 Tests...");

  // Initialize WebGPU
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
      console.error("❌ WebGPU not available.");
      process.exit(1);
  }

  if (!adapter) process.exit(1);
  const device = await adapter.requestDevice();

  let passedCount = 0;
  for (const testCase of MAINNET_CREATE2_TESTCASES) {
      const passed = await runTest(device, testCase);
      if (passed) passedCount++;
  }

  if (passedCount === MAINNET_CREATE2_TESTCASES.length) {
      console.log(`\n✅ All ${passedCount} Tests Passed!`);
      process.exit(0);
  } else {
      console.log(`\n❌ ${MAINNET_CREATE2_TESTCASES.length - passedCount} Tests Failed.`);
      process.exit(1);
  }
}

async function runTest(device: GPUDevice, testCase: any) {
    console.log(`\nTest Case: ${testCase.name}`);
    console.log(`Target: ${testCase.expectedAddress}`);

    // Parse Salt
    // Salt is 32 bytes hex string.
    // We need to extract:
    // Prefix (20 bytes) -> Bytes 0..19
    // Mid (4 bytes) -> Bytes 20..23
    // Low (4 bytes) -> Bytes 24..27
    // High (4 bytes) -> Bytes 28..31

    const saltHex = testCase.salt.startsWith("0x") ? testCase.salt.slice(2) : testCase.salt;
    if (saltHex.length !== 64) {
        console.error(`Invalid salt length: ${saltHex.length}`);
        return false;
    }

    const prefixHex = saltHex.slice(0, 40); // 20 bytes * 2 chars
    const midHex = saltHex.slice(40, 48); // 4 bytes
    const lowHex = saltHex.slice(48, 56); // 4 bytes
    const highHex = saltHex.slice(56, 64); // 4 bytes

    // Convert to Little Endian u32 values for Mid, Low, High
    // The hex string "AABBCCDD" represents bytes [AA, BB, CC, DD].
    // As a u32 on LE machine, this is 0xDDCCBBAA.
    const reverseHex = (s: string) => s.match(/../g)!.reverse().join('');

    const midLE = parseInt(reverseHex(midHex), 16);
    const lowLE = parseInt(reverseHex(lowHex), 16);
    const highLE = parseInt(reverseHex(highHex), 16);

    // Load Verification Shader
    const shaderCode = await Bun.file(join(import.meta.dir, "verification.wgsl")).text();
    const shaderModule = device.createShaderModule({ code: shaderCode });

    // Prepare Template
    const templateState = new Uint32Array(50);
    const sponge = new Uint8Array(templateState.buffer);

    sponge[0] = 0xff;

    // Factory Address
    const factoryBytes = ethers.getBytes(testCase.deployer);
    for(let i=0; i<20; i++) sponge[1+i] = factoryBytes[i];

    // Salt Prefix
    const prefixBytes = ethers.getBytes("0x" + prefixHex);
    for(let i=0; i<20; i++) sponge[21+i] = prefixBytes[i];

    // InitCodeHash
    const hashBytes = ethers.getBytes(testCase.initCodeHash);
    for(let i=0; i<32; i++) sponge[53+i] = hashBytes[i];

    // Mid
    const midBytes = new Uint8Array(new Uint32Array([midLE]).buffer);
    sponge[41] = midBytes[0];
    sponge[42] = midBytes[1];
    sponge[43] = midBytes[2];
    sponge[44] = midBytes[3];

    sponge[85] = 0x01;
    sponge[135] = 0x80;

    const templateBuffer = device.createBuffer({
        size: templateState.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(templateBuffer, 0, templateState);

    // Params
    const paramsArray = new Uint32Array([
        highLE, // nonce_high
        lowLE,  // threshold (used as nonce_low hack)
        0, 0
    ]);
    const paramsBuffer = device.createBuffer({
        size: paramsArray.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(paramsBuffer, 0, paramsArray);

    const outputBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST
    });

    // Run
    const pipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: shaderModule, entryPoint: "main" }
    });

    const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: { buffer: templateBuffer } },
            { binding: 1, resource: { buffer: paramsBuffer } },
            { binding: 2, resource: { buffer: outputBuffer } },
        ]
    });

    const commandEncoder = device.createCommandEncoder();
    const passEncoder = commandEncoder.beginComputePass();
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.dispatchWorkgroups(1);
    passEncoder.end();

    // Readback
    const readbackBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST
    });
    commandEncoder.copyBufferToBuffer(outputBuffer, 0, readbackBuffer, 0, 32);
    device.queue.submit([commandEncoder.finish()]);
    await device.queue.onSubmittedWorkDone();

    await readbackBuffer.mapAsync(GPUMapMode.READ);
    const result = new Uint8Array(readbackBuffer.getMappedRange());
    const resultHex = "0x" + Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');

    // Address is first 20 bytes of result (due to shader outputting sponge[12..])
    const address = "0x" + resultHex.slice(2, 42);

    console.log(`Computed: ${address.toLowerCase()}`);

    if (address.toLowerCase() === testCase.expectedAddress.toLowerCase()) {
        console.log(`✅ MATCH`);
        return true;
    } else {
        console.log(`❌ MISMATCH`);
        return false;
    }
}

main().catch(console.error);
