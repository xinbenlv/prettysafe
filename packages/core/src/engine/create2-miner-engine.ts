import { type Address, type Hex } from 'viem';
import { encodeSafeSetup, prepareShaderData, deriveSafeAddress, type SafeConfig } from '../safe-encoder';

export interface MinerConfig {
  safeConfig: SafeConfig;
  shaderCode: string;
}

export interface MinerState {
  isRunning: boolean;
  isPaused: boolean;
  totalHashes: number;
  hashrate: number;
  elapsedTime: number;
  bestNonce: bigint | null;
  bestAddress: Address | null;
  initializer: Hex | null;
  error: string | null;
}

export interface MinerCallbacks {
  onStateChange: (state: MinerState) => void;
  onError?: (error: string) => void;
}

interface GPUResources {
  device: GPUDevice;
  pipeline: GPUComputePipeline;
  bindGroup: GPUBindGroup;
  constantsBuffer: GPUBuffer;
  paramsBuffer: GPUBuffer;
  resultsBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  isDestroyed: boolean;
}

export class Create2MinerEngine {
  private gpuResources: GPUResources | null = null;
  private miningLoop: number | null = null;
  private startTime = 0;
  private iteration = 0;
  private shouldStop = false;
  private config: SafeConfig | null = null;
  private callbacks: MinerCallbacks | null = null;

  private state: MinerState = {
    isRunning: false,
    isPaused: false,
    totalHashes: 0,
    hashrate: 0,
    elapsedTime: 0,
    bestNonce: null,
    bestAddress: null,
    initializer: null,
    error: null,
  };

  private updateState(partial: Partial<MinerState>) {
    this.state = { ...this.state, ...partial };
    this.callbacks?.onStateChange(this.state);
  }

  static async checkWebGPU(): Promise<{ supported: boolean; message: string; vendor?: string }> {
    if (typeof navigator === 'undefined' || !navigator.gpu) {
      return { supported: false, message: 'WebGPU not supported' };
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        return { supported: false, message: 'No WebGPU adapter found' };
      }
      return {
        supported: true,
        message: 'WebGPU Ready',
        vendor: `${adapter.info.vendor} ${adapter.info.architecture}`,
      };
    } catch {
      return { supported: false, message: 'Failed to initialize WebGPU' };
    }
  }

  private async initializeGPU(config: SafeConfig, shaderCode: string): Promise<GPUResources | null> {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) throw new Error('No WebGPU adapter available');

      const device = await adapter.requestDevice();
      const shaderModule = device.createShaderModule({ code: shaderCode });
      const shaderData = prepareShaderData(config);

      // Constants buffer: initializerHash (32) + factory (20 padded to 24) + proxyCodeHash (32) = 88 bytes, align to 96
      const constantsData = new Uint32Array(24); // 96 bytes

      // Copy initializerHash (8 u32s = 32 bytes)
      for (let i = 0; i < 8; i++) {
        constantsData[i] = (shaderData.initializerHash[i * 4] |
                          (shaderData.initializerHash[i * 4 + 1] << 8) |
                          (shaderData.initializerHash[i * 4 + 2] << 16) |
                          (shaderData.initializerHash[i * 4 + 3] << 24)) >>> 0;
      }

      // Copy factory address (5 u32s = 20 bytes)
      for (let i = 0; i < 5; i++) {
        constantsData[8 + i] = (shaderData.factoryAddress[i * 4] |
                               (shaderData.factoryAddress[i * 4 + 1] << 8) |
                               (shaderData.factoryAddress[i * 4 + 2] << 16) |
                               (shaderData.factoryAddress[i * 4 + 3] << 24)) >>> 0;
      }

      // Copy proxyCodeHash (8 u32s = 32 bytes)
      for (let i = 0; i < 8; i++) {
        constantsData[13 + i] = (shaderData.proxyCodeHash[i * 4] |
                                (shaderData.proxyCodeHash[i * 4 + 1] << 8) |
                                (shaderData.proxyCodeHash[i * 4 + 2] << 16) |
                                (shaderData.proxyCodeHash[i * 4 + 3] << 24)) >>> 0;
      }

      const constantsBuffer = device.createBuffer({
        size: constantsData.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(constantsBuffer, 0, constantsData);

      const paramsBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      const resultsBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      const readbackBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      // Initialize results with max address (0xFFFFFFFF...)
      const initialResults = new Uint32Array(8);
      initialResults.fill(0xFFFFFFFF);
      initialResults[7] = 0; // found = 0
      device.queue.writeBuffer(resultsBuffer, 0, initialResults);

      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'main' },
      });

      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: constantsBuffer } },
          { binding: 1, resource: { buffer: paramsBuffer } },
          { binding: 2, resource: { buffer: resultsBuffer } },
        ],
      });

      return { device, pipeline, bindGroup, constantsBuffer, paramsBuffer, resultsBuffer, readbackBuffer, isDestroyed: false };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to initialize GPU';
      this.updateState({ error: message });
      return null;
    }
  }

  async start(minerConfig: MinerConfig, callbacks: MinerCallbacks): Promise<void> {
    if (this.state.isRunning) return;

    this.config = minerConfig.safeConfig;
    this.callbacks = callbacks;

    const initializerData = encodeSafeSetup(minerConfig.safeConfig);

    this.updateState({
      isRunning: true,
      isPaused: false,
      totalHashes: 0,
      hashrate: 0,
      elapsedTime: 0,
      bestNonce: null,
      bestAddress: null,
      initializer: initializerData,
      error: null,
    });

    this.shouldStop = false;
    this.iteration = 0;
    this.startTime = performance.now();

    const resources = await this.initializeGPU(minerConfig.safeConfig, minerConfig.shaderCode);
    if (!resources) {
      this.updateState({ isRunning: false });
      return;
    }
    this.gpuResources = resources;

    this.runMiningLoop();
  }

  private async runMiningLoop(): Promise<void> {
    const resources = this.gpuResources;
    if (!resources || this.shouldStop || resources.isDestroyed) {
      this.updateState({ isRunning: false });
      return;
    }

    const { device, pipeline, bindGroup, paramsBuffer, resultsBuffer, readbackBuffer } = resources;
    const workgroupSize = 64;
    const dispatchX = 65535;
    const dispatchY = 16;
    const itemsPerDispatch = workgroupSize * dispatchX * dispatchY;

    try {
      if (this.shouldStop || resources.isDestroyed) return;

      const params = new Uint32Array([0, this.iteration, 0, 0]);
      device.queue.writeBuffer(paramsBuffer, 0, params);

      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchX, dispatchY);
      pass.end();

      commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, 32);
      device.queue.submit([commandEncoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      if (this.shouldStop || resources.isDestroyed) return;

      try {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
      } catch (mapError) {
        if (this.shouldStop || resources.isDestroyed) return;
        throw mapError;
      }

      const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
      readbackBuffer.unmap();

      const found = resultData[7] === 1;

      this.iteration++;
      const totalHashes = this.iteration * itemsPerDispatch;
      const elapsed = (performance.now() - this.startTime) / 1000;
      const hashrate = totalHashes / elapsed;

      let bestNonce = this.state.bestNonce;
      let bestAddress = this.state.bestAddress;

      if (found && this.config) {
        const nonceLow = resultData[0];
        const nonceHigh = resultData[1];
        const gpuNonce = BigInt(nonceHigh) * BigInt(0x100000000) + BigInt(nonceLow);

        // Verify the result on CPU to guard against GPU race conditions
        const verified = deriveSafeAddress(this.config, gpuNonce);

        if (bestAddress === null || BigInt(verified.address) < BigInt(bestAddress)) {
          bestNonce = gpuNonce;
          bestAddress = verified.address;
        }
      }

      this.updateState({ totalHashes, hashrate, elapsedTime: elapsed, bestNonce, bestAddress });

      if (!this.shouldStop) {
        this.miningLoop = requestAnimationFrame(() => this.runMiningLoop());
      }
    } catch (error: unknown) {
      if (this.shouldStop || resources.isDestroyed) return;
      const message = error instanceof Error ? error.message : 'Mining error';
      this.updateState({ isRunning: false, error: message });
      this.callbacks?.onError?.(message);
    }
  }

  stop(): void {
    this.shouldStop = true;
    if (this.miningLoop) {
      cancelAnimationFrame(this.miningLoop);
      this.miningLoop = null;
    }
    this.updateState({ isRunning: false });

    if (this.gpuResources) {
      this.gpuResources.isDestroyed = true;
      const device = this.gpuResources.device;
      this.gpuResources = null;
      setTimeout(() => {
        try { device.destroy(); } catch { /* ignore */ }
      }, 100);
    }
  }

  pause(): void {
    if (!this.state.isRunning) return;
    this.shouldStop = true;
    this.updateState({ isPaused: true, isRunning: false });
  }

  resume(): void {
    if (!this.state.isPaused || !this.gpuResources) return;
    this.shouldStop = false;
    this.updateState({ isPaused: false, isRunning: true });
    this.runMiningLoop();
  }

  destroy(): void {
    this.stop();
    this.callbacks = null;
    this.config = null;
  }

  getState(): MinerState {
    return { ...this.state };
  }
}
