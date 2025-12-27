import shaderCode from './keccak.wgsl?raw';

const statusEl = document.getElementById('status')!;
const startBtn = document.getElementById('startBtn') as HTMLButtonElement;
const logsEl = document.getElementById('logs')!;
const durationInput = document.getElementById('duration') as HTMLInputElement;

function log(msg: string) {
    logsEl.textContent += msg + '\n';
    console.log(msg);
}

async function checkWebGPU() {
    if (!navigator.gpu) {
        statusEl.textContent = "❌ WebGPU not supported in this browser.";
        statusEl.className = "status error";
        return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        statusEl.textContent = "❌ No WebGPU adapter found.";
        statusEl.className = "status error";
        return;
    }
    statusEl.textContent = `✅ WebGPU Ready: ${adapter.info.vendor} ${adapter.info.architecture}`;
    statusEl.className = "status success";
    startBtn.disabled = false;
}

async function runBenchmark() {
    startBtn.disabled = true;
    logsEl.textContent = "";
    const seconds = parseInt(durationInput.value) || 5;

    try {
        const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
        const device = await adapter!.requestDevice();

        log(`Using GPU: ${adapter!.info.vendor}`);
        log(`Running for ${seconds} seconds...`);

        const shaderModule = device.createShaderModule({ code: shaderCode });

        // Setup Buffers
        const templateState = new Uint32Array(50);
        for (let i = 0; i < 50; i++) templateState[i] = Math.floor(Math.random() * 0xFFFFFFFF);

        const templateBuffer = device.createBuffer({
            size: templateState.byteLength,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        });
        device.queue.writeBuffer(templateBuffer, 0, templateState);

        const paramsBuffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });

        const solutionsBuffer = device.createBuffer({
            size: 8,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
        });

        const pipeline = device.createComputePipeline({
            layout: "auto",
            compute: { module: shaderModule, entryPoint: "main" },
        });

        const bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: templateBuffer } },
                { binding: 1, resource: { buffer: paramsBuffer } },
                { binding: 2, resource: { buffer: solutionsBuffer } },
            ],
        });

        const workgroupSize = 256;
        const dispatchCount = 65535;
        const itemsPerDispatch = workgroupSize * dispatchCount;

        let totalHashes = 0;
        const startTime = performance.now();
        let iterations = 0;

        while (true) {
            const now = performance.now();
            if ((now - startTime) / 1000 >= seconds) break;

            const params = new Uint32Array([iterations, 0, 0, 0]);
            device.queue.writeBuffer(paramsBuffer, 0, params);

            const commandEncoder = device.createCommandEncoder();
            const pass = commandEncoder.beginComputePass();
            pass.setPipeline(pipeline);
            pass.setBindGroup(0, bindGroup);
            pass.dispatchWorkgroups(dispatchCount);
            pass.end();

            device.queue.submit([commandEncoder.finish()]);
            await device.queue.onSubmittedWorkDone();

            totalHashes += itemsPerDispatch;
            iterations++;

            if (iterations % 5 === 0) {
                log(`... ${(now - startTime).toFixed(0)}ms | ${(totalHashes / 1e6).toFixed(2)} MH`);
            }
        }

        const duration = (performance.now() - startTime) / 1000;
        const hashrate = totalHashes / duration;

        log(`\nDONE!`);
        log(`Total Hashes: ${totalHashes.toLocaleString()}`);
        log(`Duration: ${duration.toFixed(4)}s`);
        log(`Hashrate: ${(hashrate / 1e6).toFixed(2)} MH/s`);

    } catch (e: any) {
        log(`Error: ${e.message}`);
    } finally {
        startBtn.disabled = false;
    }
}

checkWebGPU();
startBtn.onclick = runBenchmark;

