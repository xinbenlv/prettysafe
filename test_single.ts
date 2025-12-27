import { join } from "path";

// Types for WebGPU are provided by @webgpu/types
// In a real environment (browser/Deno), navigator.gpu is available.
// In Bun/Node, we might need a polyfill or binding.
// For this script, we assume a WebGPU-compatible environment or we mock/fail gracefully.

async function main() {
  console.log("Validating WebGPU Keccak256 vs Ethers.js...");

  let adapter: GPUAdapter | null = null;

  if (typeof navigator !== 'undefined' && navigator.gpu) {
    adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance"
    });
  } else {
    // Attempt to load from 'bun-webgpu' if installed
    try {
        const mod = await import("bun-webgpu");
        // @ts-ignore
        if (mod.setupGlobals) {
             // @ts-ignore
             mod.setupGlobals();
        }
        // @ts-ignore
        if (mod.createGPUInstance) {
            // @ts-ignore
            const gpu = mod.createGPUInstance();
            adapter = await gpu.requestAdapter();
        }
    } catch (e) {
        console.error("Could not load bun-webgpu:", e);
    }

    if (!adapter) {
        console.error("WebGPU not supported in this environment.");
        process.exit(1);
    }
  }

  const device = await adapter.requestDevice();
  console.log(`Using GPU: ${adapter.info.vendor} ${adapter.info.architecture}`);

  // Load Parameters
  const paramsData = await Bun.file("validation_params.json").json();
  const { factoryAddress, salt, initCodeHash, expectedAddress } = paramsData;

  console.log(`Testing with:`);
  console.log(`Factory: ${factoryAddress}`);
  console.log(`Salt: ${salt}`);
  console.log(`Hash: ${initCodeHash}`);
  console.log(`Expected (Ethers): ${expectedAddress}`);

  // Load WGSL shader
  const shaderCode = await Bun.file(join(import.meta.dir, "keccak.wgsl")).text();
  const shaderModule = device.createShaderModule({ code: shaderCode });

  // Prepare input data
  // We need to construct the 25-u64 (50-u32) sponge state just like the Rust code does.
  // Keccak256(0xff ++ factory ++ salt ++ hash)
  // Input to keccak is: 1 byte (0xff) + 20 bytes + 32 bytes + 32 bytes = 85 bytes.
  // Block size is 136 bytes. So all fits in one block (sponge[0..16]).
  // We need to fill the sponge buffer manually here to match the kernel's expectation.

  // Wait, the Kernel `keccak256.cl` expects `S_1`.. constants.
  // And it injects Nonce.
  // The kernel computes:
  // sponge[0] = 0xff
  // sponge[1]..[20] = S_1..S_20 (Factory)
  // sponge[21]..[40] = S_21..S_40 (Caller? Or Salt Prefix?)
  // sponge[41]..[44] = d_message (Salt Middle)
  // sponge[45]..[52] = nonce (Salt End)
  // sponge[53]..[84] = S_53..S_84 (Hash)
  // sponge[85] = 0x01 (Padding start)
  // ...
  // sponge[135] = 0x80 (Padding end)

  // We need to map our Salt (32 bytes) to S_21..S_40 + d_message + nonce.
  // Salt: 0x0000000000000000000000000000000000000000ebf9c231fad1d33999ec0da2
  // Bytes 0-19 (20 bytes) = 0x00...00 -> S_21..S_40
  // Bytes 20-23 (4 bytes) = 0xebf9c231 -> d_message
  // Bytes 24-31 (8 bytes) = 0xfad1d33999ec0da2 -> Nonce (High: fad1d339, Low: 99ec0da2)

  const state = new Uint8Array(200); // 200 bytes = 25 u64s

  state[0] = 0xff;

  // Factory
  const factoryBytes = Buffer.from(factoryAddress.slice(2), 'hex');
  for (let i = 0; i < 20; i++) state[1 + i] = factoryBytes[i];

  // Salt Prefix (20 bytes of zeros)
  for (let i = 0; i < 20; i++) state[21 + i] = 0;

  // Message (4 bytes) - Passed via Uniform in Kernel, but here we prep it in Template
  // Wait, the Kernel `template_state` should contain everything EXCEPT the nonce parts we change.
  // The Kernel modifies state[5] (bytes 40-47) and state[6] (bytes 48-55).
  // Byte 41,42,43,44 corresponds to d_message.
  // Wait, in OpenCL:
  // sponge[41] = d_message[0];
  // ...
  // sponge[44] = d_message[3];

  // In our Salt: `ebf9c231`
  // Byte 20 -> sponge[21+20] = sponge[41] = 0xeb
  // Byte 21 -> sponge[42] = 0xf9
  // Byte 22 -> sponge[43] = 0xc2
  // Byte 23 -> sponge[44] = 0x31

  state[41] = 0xeb;
  state[42] = 0xf9;
  state[43] = 0xc2;
  state[44] = 0x31;

  // Hash (32 bytes)
  const hashBytes = Buffer.from(initCodeHash.slice(2), 'hex');
  for (let i = 0; i < 32; i++) state[53 + i] = hashBytes[i];

  // Padding
  state[85] = 0x01;
  state[135] = 0x80;

  // Convert to u32 array (Little Endian)
  const templateState = new Uint32Array(50);
  const stateView = new DataView(state.buffer);
  for (let i = 0; i < 50; i++) {
      templateState[i] = stateView.getUint32(i * 4, true); // Little Endian
  }

  // Params
  // Nonce High: 0xfad1d339
  // Nonce Low: 0x99ec0da2

  // Create buffers
  const templateBuffer = device.createBuffer({
    size: templateState.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(templateBuffer, 0, templateState);

  // We only run 1 thread (workgroup size 1, dispatch 1) to test specific nonce
  const paramsBufferSize = 16;
  const paramsBuffer = device.createBuffer({
    size: paramsBufferSize,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const solutionsBufferSize = 8;
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

  // Set Params
  // Nonce High = 0xfad1d339
  // Threshold = 0 (we want to check result manually, but shader checks threshold)
  // Shader: if ((digest_word0 & 0xFFFFFFFFu) == 0u) ...
  // Wait, shader ONLY writes if first word is 0 (or masked).
  // 0x2017... starts with 20. It is NOT zero.
  // So the shader won't write anything.
  // We need to modify the shader to ALWAYS write the hash (or part of it) for debugging?
  // Or we just check if it finds the "Solution" which is the nonce.
  // But we gave it the nonce.
  // The goal is to verify the ADDRESS.
  // The shader calculates address but doesn't output it directly, it checks constraints.

  // To validate, we should modify the shader to OUTPUT the digest (first 2 words) to `solutions`.
  // Let's modify the shader in memory or use a different entry point?
  // Easier: Assume the shader logic is correct for hashing, verify the HASHRATE logic?
  // No, user wants to validate LOGIC yields same result.
  // So we must see the result.

  // Let's perform a hack: Modify the shader code string before compiling to write the digest to solutions.
  // Original:
  // if (digest_word0 == 0u) { solutions[0] = nonce_low; ... }
  // New:
  // solutions[0] = state[1].y; // Digest word 0 (bytes 0-3 of hash -> bytes 12-15 of sponge)
  // solutions[1] = state[2].x; // Digest word 1 (bytes 4-7 of hash -> bytes 16-19 of sponge)
  // Note: OpenCL `digest` pointer logic:
  // sponge is ulong[25]. digest = sponge + 12 bytes.
  // sponge[0] (0-7), sponge[1] (8-15).
  // digest starts at byte 12.
  // byte 12 is sponge[1] >> 32. (state[1].y)
  // byte 16 is sponge[2] & 0xFFFFFFFF. (state[2].x)

  const debugShaderCode = shaderCode.replace(
      /if \(\(digest_word0 & 0xFFFFFFFFu\) == 0u\) \{[\s\S]*?\}/,
      `
      solutions[0] = state[1].y;
      solutions[1] = state[2].x;
      `
  );

  const debugModule = device.createShaderModule({ code: debugShaderCode });
  const debugPipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: debugModule, entryPoint: "main" },
  });

  // Set params
  // High part of nonce
  const params = new Uint32Array([0xfad1d339, 0, 0, 0]);
  device.queue.writeBuffer(paramsBuffer, 0, params);

  const commandEncoder = device.createCommandEncoder();
  const passEncoder = commandEncoder.beginComputePass();
  passEncoder.setPipeline(debugPipeline);
  passEncoder.setBindGroup(0, bindGroup);
  // We want Nonce Low to be 0x99ec0da2
  // GlobalID.x provides Nonce Low.
  // We can dispatch(1) and hardcode offset?
  // No, we can't easily set GlobalID start.
  // We will dispatch 1 workgroup of size 1.
  // But we need Nonce Low to be specific.
  // We can pass Nonce Low via another Uniform?
  // Or just hack it: The shader uses `global_id.x` as Nonce Low.
  // We can modify shader to use `params.padding` as Nonce Low for this test.

  // Replace `let nonce_low = global_id.x;` with `let nonce_low = 0x99ec0da2u;`
  const debugShaderCode2 = debugShaderCode.replace(
      "let nonce_low = global_id.x;",
      "let nonce_low = 0x99ec0da2u;"
  );

  const debugModule2 = device.createShaderModule({ code: debugShaderCode2 });
  const debugPipeline2 = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module: debugModule2, entryPoint: "main" },
  });

  const passEncoder2 = commandEncoder.beginComputePass();
  passEncoder2.setPipeline(debugPipeline2);
  passEncoder2.setBindGroup(0, bindGroup);
  passEncoder2.dispatchWorkgroups(1);
  passEncoder2.end();

  device.queue.submit([commandEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  // Read results
  // We need to copy buffer to read it (WebGPU requires mapAsync on MAP_READ buffers)
  // `solutionsBuffer` has STORAGE | COPY_SRC. We need a READ buffer.
  const readBuffer = device.createBuffer({
      size: solutionsBufferSize,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
  });

  const copyEncoder = device.createCommandEncoder();
  copyEncoder.copyBufferToBuffer(solutionsBuffer, 0, readBuffer, 0, solutionsBufferSize);
  device.queue.submit([copyEncoder.finish()]);
  await device.queue.onSubmittedWorkDone();

  await readBuffer.mapAsync(GPUMapMode.READ);
  const results = new Uint32Array(readBuffer.getMappedRange());

  console.log("WebGPU Result (First 8 bytes of Hash):");
  console.log(`Word0: 0x${results[0].toString(16).padStart(8, '0')}`);
  console.log(`Word1: 0x${results[1].toString(16).padStart(8, '0')}`);

  // Calculate expected hash (Address is last 20 bytes of Hash)
  // But we are outputting the FIRST 8 bytes of the Keccak256 hash.
  // The Address is derived from the LAST 20 bytes of the hash.
  // Keccak256(0xff ++ ...) = 32 bytes.
  // Address = bytes 12..31.
  // Bytes 0..11 are discarded.
  // Wait, Word0 (bytes 0-3) and Word1 (bytes 4-7) are NOT part of the address.
  // We need bytes 12-19.
  // Byte 12 starts at Word3?
  // Byte 0: Word0[0]
  // ...
  // Byte 12: Word3[0] (0-indexed words? No, 32-bit words)
  // Word0: 0-3
  // Word1: 4-7
  // Word2: 8-11
  // Word3: 12-15 -> This is the start of Address.

  // In Shader:
  // state[1].y = bytes 12..15 (Word3)
  // state[2].x = bytes 16..19 (Word4)
  // My shader mod was:
  // solutions[0] = state[1].y;
  // solutions[1] = state[2].x;
  // So I AM outputting bytes 12-19.
  // This corresponds to the FIRST 8 bytes of the ADDRESS.

  const computedAddrHex = expectedAddress.slice(2); // 20177ba2...
  const expectedWord0 = parseInt(computedAddrHex.slice(0, 8), 16); // 20177ba2
  // Note: Endianness.
  // state[1].y is a u32.
  // If the hash byte stream is `20 17 7b a2 ...`
  // And we load it as u32 (Little Endian): `a2 7b 17 20` -> 0xa27b1720.
  // So we expect the output to be Little Endian version of the address bytes.

  // Let's just output and see.

  console.log(`Expected Address Start: 0x${computedAddrHex.slice(0, 8)}`);
}

main().catch(console.error);

