import { join } from "path";
import { ethers } from "ethers";

// Known valid test case extracted earlier
const TEST_CASE = {
    factoryAddress: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    saltPrefix: "0x0000000000000000000000000000000000000000",
    saltMidLE: 0x31c2f9eb, // "eb f9 c2 31"
    nonceLow: 0x99ec0da2, // "fa d1 d3 39" -> but hex string was "fad1d33999ec0da2". Wait.
    // In extraction I parsed:
    // Nonce High = 0xfad1d339 (No, High was last part?)
    // Let's re-verify the mapping from my successful run.
    // In `validate.ts`:
    // SaltData (32 bytes).
    // Mid = 40..48 (4 bytes)
    // Low = 48..56 (4 bytes)
    // High = 56..64 (4 bytes)
    //
    // Salt: ...ebf9c231 fad1d339 99ec0da2
    // Mid: ebf9c231
    // Next 4 bytes: fad1d339
    // Next 4 bytes: 99ec0da2
    //
    // In `validate.ts` I reversed them to LE.
    // reverseHex("fad1d339") -> "39d3d1fa" -> 0x39d3d1fa.
    // reverseHex("99ec0da2") -> "a20dec99" -> 0xa20dec99.
    //
    // `nonceLow` corresponds to `global_id.x`.
    // `nonceHigh` corresponds to `params.x`.
    //
    // In `keccak.wgsl` (and `verification.wgsl`):
    // `nonce_low = global_id.x`
    // `nonce_high = params.x`
    // Bytes 0-3 of Nonce Block come from Low.
    // Bytes 4-7 of Nonce Block come from High.
    //
    // In Salt: [Prefix 20] [Mid 4] [NonceBlock 8]
    // NonceBlock = [Byte 0..3] [Byte 4..7]
    // "fad1d339" are bytes 0..3 of NonceBlock.
    // So this is Low.
    // "99ec0da2" are bytes 4..7 of NonceBlock.
    // So this is High.

    // So:
    // Nonce Low Bytes: fa d1 d3 39
    // Nonce High Bytes: 99 ec 0d a2

    // As u32 LE values:
    nonceLow: 0x39d3d1fa,
    nonceHigh: 0xa20dec99,

    initCodeHash: "0x1d34e4a585a1a5a873534f4560f8d06292b66a174493fe2b99331a68cae46baa",
    expectedAddress: "0x20177BA2c39BAdD04B43a3D6BBe8a92a22957681" // Computed by Ethers with these inputs
};

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

  // Run Test Case 1
  const passed = await runTest(device, TEST_CASE);

  if (passed) {
      console.log("\n✅ All Tests Passed!");
      process.exit(0);
  } else {
      console.log("\n❌ Tests Failed.");
      process.exit(1);
  }
}

async function runTest(device: GPUDevice, testCase: any) {
    console.log(`\nTest Case: Validating against ${testCase.expectedAddress}...`);

    // Load Verification Shader
    const shaderCode = await Bun.file(join(import.meta.dir, "verification.wgsl")).text();
    const shaderModule = device.createShaderModule({ code: shaderCode });

    // Prepare Template
    const templateState = new Uint32Array(50);
    const sponge = new Uint8Array(templateState.buffer);

    sponge[0] = 0xff;
    const factoryBytes = ethers.getBytes(testCase.factoryAddress);
    for(let i=0; i<20; i++) sponge[1+i] = factoryBytes[i];
    const saltPrefixBytes = ethers.getBytes(testCase.saltPrefix);
    for(let i=0; i<20; i++) sponge[21+i] = saltPrefixBytes[i];
    const hashBytes = ethers.getBytes(testCase.initCodeHash);
    for(let i=0; i<32; i++) sponge[53+i] = hashBytes[i];

    // Mid
    const midBytes = new Uint8Array(new Uint32Array([testCase.saltMidLE]).buffer);
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
        testCase.nonceHigh,
        testCase.nonceLow, // Passed as threshold hack
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

    console.log(`Expected: ${testCase.expectedAddress.toLowerCase()}`);
    console.log(`Actual:   ${address.toLowerCase()}`);

    return address.toLowerCase() === testCase.expectedAddress.toLowerCase();
}

main().catch(console.error);
