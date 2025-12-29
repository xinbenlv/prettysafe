import { useState, useEffect, useCallback } from 'react';
import shaderCode from '../../keccak.wgsl?raw';

interface WebGPUStatus {
  supported: boolean;
  message: string;
  vendor?: string;
}

interface BenchmarkResult {
  hashrate: number;
  totalHashes: number;
  duration: number;
}

export function useWebGPUBenchmark() {
  const [webGPUStatus, setWebGPUStatus] = useState<WebGPUStatus>({
    supported: false,
    message: 'Checking WebGPU support...',
  });

  useEffect(() => {
    checkWebGPU();
  }, []);

  const checkWebGPU = async () => {
    if (!navigator.gpu) {
      setWebGPUStatus({
        supported: false,
        message: '❌ WebGPU not supported in this browser',
      });
      return;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) {
        setWebGPUStatus({
          supported: false,
          message: '❌ No WebGPU adapter found',
        });
        return;
      }

      setWebGPUStatus({
        supported: true,
        message: '✅ WebGPU Ready',
        vendor: `${adapter.info.vendor} ${adapter.info.architecture}`,
      });
    } catch (error) {
      setWebGPUStatus({
        supported: false,
        message: '❌ Failed to initialize WebGPU',
      });
    }
  };

  const runWebGPUBenchmark = useCallback(async (
    seconds: number,
    log: (msg: string) => void
  ): Promise<BenchmarkResult | null> => {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        throw new Error('No WebGPU adapter available');
      }

      const device = await adapter.requestDevice();
      log(`GPU: ${adapter.info.vendor} ${adapter.info.architecture}`);

      const shaderModule = device.createShaderModule({ code: shaderCode });

      // Setup buffers
      const templateState = new Uint32Array(50);
      for (let i = 0; i < 50; i++) {
        templateState[i] = Math.floor(Math.random() * 0xFFFFFFFF);
      }

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
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'main' },
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: templateBuffer } },
          { binding: 1, resource: { buffer: paramsBuffer } },
          { binding: 2, resource: { buffer: solutionsBuffer } },
        ],
      });

      const workgroupSize = 64;
      const dispatchCountX = 65535;
      const dispatchCountY = 16;
      const itemsPerDispatch = workgroupSize * dispatchCountX * dispatchCountY;

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
        pass.dispatchWorkgroups(dispatchCountX, dispatchCountY);
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

      log(`Total: ${totalHashes.toLocaleString()} hashes in ${duration.toFixed(2)}s`);

      return { hashrate, totalHashes, duration };
    } catch (error: any) {
      log(`WebGPU Error: ${error.message}`);
      return null;
    }
  }, []);

  return { webGPUStatus, runWebGPUBenchmark };
}
