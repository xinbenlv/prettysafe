import { useState, useEffect, useCallback, useRef } from 'react';
import { type Address, type Hex } from 'viem';
import { encodeSafeSetup, prepareShaderData, deriveSafeAddress, type SafeConfig } from '../lib/safe-encoder';
import shaderCode from '../../gnosis-create2.wgsl?raw';

export interface MiningState {
  isRunning: boolean;
  isPaused: boolean;
  totalHashes: number;
  hashrate: number;
  elapsedTime: number;
  bestNonce: bigint | null;
  bestAddress: Address | null;
  error: string | null;
}

export interface WebGPUMinerStatus {
  supported: boolean;
  message: string;
  vendor?: string;
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

export function useSafeMiner() {
  const [status, setStatus] = useState<WebGPUMinerStatus>({
    supported: false,
    message: 'Checking WebGPU support...',
  });

  const [miningState, setMiningState] = useState<MiningState>({
    isRunning: false,
    isPaused: false,
    totalHashes: 0,
    hashrate: 0,
    elapsedTime: 0,
    bestNonce: null,
    bestAddress: null,
    error: null,
  });

  const [initializer, setInitializer] = useState<Hex | null>(null);

  const gpuResourcesRef = useRef<GPUResources | null>(null);
  const miningLoopRef = useRef<number | null>(null);
  const startTimeRef = useRef<number>(0);
  const iterationRef = useRef<number>(0);
  const shouldStopRef = useRef<boolean>(false);
  const configRef = useRef<SafeConfig | null>(null);

  // Check WebGPU support on mount
  useEffect(() => {
    checkWebGPU();
  }, []);

  const checkWebGPU = async () => {
    if (!navigator.gpu) {
      setStatus({
        supported: false,
        message: '❌ WebGPU not supported in this browser',
      });
      return;
    }

    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        setStatus({
          supported: false,
          message: '❌ No WebGPU adapter found',
        });
        return;
      }

      setStatus({
        supported: true,
        message: '✅ WebGPU Ready',
        vendor: `${adapter.info.vendor} ${adapter.info.architecture}`,
      });
    } catch (error) {
      setStatus({
        supported: false,
        message: '❌ Failed to initialize WebGPU',
      });
    }
  };

  const initializeGPU = async (config: SafeConfig): Promise<GPUResources | null> => {
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) {
        throw new Error('No WebGPU adapter available');
      }

      const device = await adapter.requestDevice();

      // Compile shader
      const shaderModule = device.createShaderModule({ code: shaderCode });

      // Prepare constant data
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

      // Params buffer: nonce_offset (u32) + iteration (u32) + padding (2 u32s) = 16 bytes
      const paramsBuffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });

      // Results buffer: nonce (2 u32s) + address (5 u32s) + found flag (1 u32) = 32 bytes
      const resultsBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      });

      // Readback buffer for CPU access
      const readbackBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      });

      // Initialize results with max address (0xFFFFFFFF...)
      const initialResults = new Uint32Array(8);
      initialResults.fill(0xFFFFFFFF);
      initialResults[7] = 0; // found = 0
      device.queue.writeBuffer(resultsBuffer, 0, initialResults);

      // Create pipeline
      const pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: shaderModule, entryPoint: 'main' },
      });

      // Create bind group
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: constantsBuffer } },
          { binding: 1, resource: { buffer: paramsBuffer } },
          { binding: 2, resource: { buffer: resultsBuffer } },
        ],
      });

      return {
        device,
        pipeline,
        bindGroup,
        constantsBuffer,
        paramsBuffer,
        resultsBuffer,
        readbackBuffer,
        isDestroyed: false,
      };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Failed to initialize GPU';
      setMiningState(prev => ({ ...prev, error: message }));
      return null;
    }
  };

  const startMining = useCallback(async (config: SafeConfig) => {
    if (miningState.isRunning) return;

    // Store config for result verification
    configRef.current = config;

    // Generate and store the initializer
    const initializerData = encodeSafeSetup(config);
    setInitializer(initializerData);

    // Reset state
    setMiningState({
      isRunning: true,
      isPaused: false,
      totalHashes: 0,
      hashrate: 0,
      elapsedTime: 0,
      bestNonce: null,
      bestAddress: null,
      error: null,
    });

    shouldStopRef.current = false;
    iterationRef.current = 0;
    startTimeRef.current = performance.now();

    // Initialize GPU resources
    const resources = await initializeGPU(config);
    if (!resources) {
      setMiningState(prev => ({ ...prev, isRunning: false }));
      return;
    }
    gpuResourcesRef.current = resources;

    // Start mining loop
    runMiningLoop();
  }, [miningState.isRunning]);

  const runMiningLoop = async () => {
    const resources = gpuResourcesRef.current;
    if (!resources || shouldStopRef.current || resources.isDestroyed) {
      setMiningState(prev => ({ ...prev, isRunning: false }));
      return;
    }

    const { device, pipeline, bindGroup, paramsBuffer, resultsBuffer, readbackBuffer } = resources;

    const workgroupSize = 64;
    const dispatchX = 65535;
    const dispatchY = 16;
    const itemsPerDispatch = workgroupSize * dispatchX * dispatchY;

    try {
      // Check if device is lost or we should stop
      if (shouldStopRef.current || resources.isDestroyed) {
        return;
      }

      // Update params
      const params = new Uint32Array([0, iterationRef.current, 0, 0]);
      device.queue.writeBuffer(paramsBuffer, 0, params);

      // Run compute pass
      const commandEncoder = device.createCommandEncoder();
      const pass = commandEncoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(dispatchX, dispatchY);
      pass.end();

      // Copy results for readback
      commandEncoder.copyBufferToBuffer(resultsBuffer, 0, readbackBuffer, 0, 32);

      device.queue.submit([commandEncoder.finish()]);
      await device.queue.onSubmittedWorkDone();

      // Check again before mapAsync (device might have been destroyed while waiting)
      if (shouldStopRef.current || resources.isDestroyed) {
        return;
      }

      // Read back results with error handling for device loss
      try {
        await readbackBuffer.mapAsync(GPUMapMode.READ);
      } catch (mapError) {
        // Device was likely destroyed - this is expected when stopping
        if (shouldStopRef.current || resources.isDestroyed) {
          return;
        }
        throw mapError;
      }

      const resultData = new Uint32Array(readbackBuffer.getMappedRange().slice(0));
      readbackBuffer.unmap();

      const found = resultData[7] === 1;

      iterationRef.current++;
      const totalHashes = iterationRef.current * itemsPerDispatch;
      const elapsed = (performance.now() - startTimeRef.current) / 1000;
      const hashrate = totalHashes / elapsed;

      // Extract best result if found
      let bestNonce: bigint | null = miningState.bestNonce;
      let bestAddress: Address | null = miningState.bestAddress;

      if (found && configRef.current) {
        const nonceLow = resultData[0];
        const nonceHigh = resultData[1];
        const gpuNonce = BigInt(nonceHigh) * BigInt(0x100000000) + BigInt(nonceLow);

        // IMPORTANT: Verify the result on CPU to guard against GPU race conditions
        // The shader has race conditions between atomic stores of nonce and address
        const verified = deriveSafeAddress(configRef.current, gpuNonce);
        
        // Only update if this is a better result than what we have
        if (bestAddress === null || BigInt(verified.address) < BigInt(bestAddress)) {
          bestNonce = gpuNonce;
          bestAddress = verified.address;
        }
      }

      setMiningState(prev => ({
        ...prev,
        totalHashes,
        hashrate,
        elapsedTime: elapsed,
        bestNonce,
        bestAddress,
      }));

      // Continue mining
      if (!shouldStopRef.current) {
        miningLoopRef.current = requestAnimationFrame(() => runMiningLoop());
      }
    } catch (error: unknown) {
      // Ignore errors if we're stopping - they're expected
      if (shouldStopRef.current || resources.isDestroyed) {
        return;
      }
      const message = error instanceof Error ? error.message : 'Mining error';
      setMiningState(prev => ({
        ...prev,
        isRunning: false,
        error: message,
      }));
    }
  };

  const stopMining = useCallback(() => {
    shouldStopRef.current = true;
    if (miningLoopRef.current) {
      cancelAnimationFrame(miningLoopRef.current);
      miningLoopRef.current = null;
    }
    setMiningState(prev => ({ ...prev, isRunning: false }));

    // Cleanup GPU resources - mark as destroyed first to prevent pending operations
    if (gpuResourcesRef.current) {
      gpuResourcesRef.current.isDestroyed = true;
      // Use setTimeout to allow pending operations to complete/fail gracefully
      const device = gpuResourcesRef.current.device;
      gpuResourcesRef.current = null;
      setTimeout(() => {
        try {
          device.destroy();
        } catch {
          // Ignore errors during cleanup
        }
      }, 100);
    }
  }, []);

  const pauseMining = useCallback(() => {
    if (!miningState.isRunning) return;
    shouldStopRef.current = true;
    setMiningState(prev => ({ ...prev, isPaused: true, isRunning: false }));
  }, [miningState.isRunning]);

  const resumeMining = useCallback(() => {
    if (!miningState.isPaused || !gpuResourcesRef.current) return;
    shouldStopRef.current = false;
    setMiningState(prev => ({ ...prev, isPaused: false, isRunning: true }));
    runMiningLoop();
  }, [miningState.isPaused]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      shouldStopRef.current = true;
      if (miningLoopRef.current) {
        cancelAnimationFrame(miningLoopRef.current);
      }
      if (gpuResourcesRef.current) {
        gpuResourcesRef.current.isDestroyed = true;
        try {
          gpuResourcesRef.current.device.destroy();
        } catch {
          // Ignore errors during cleanup
        }
      }
    };
  }, []);

  return {
    status,
    miningState,
    initializer,
    startMining,
    stopMining,
    pauseMining,
    resumeMining,
  };
}
