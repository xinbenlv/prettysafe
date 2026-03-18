import { useState, useEffect, useCallback, useRef } from 'react';
import { type Address, type Hex } from 'viem';
import { Create2MinerEngine, type SafeConfig, type MinerState } from '@prettysafe/core';
import { gnosisCreate2Shader } from '@prettysafe/core/shaders';

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
  const engineRef = useRef<Create2MinerEngine | null>(null);

  // Check WebGPU support on mount
  useEffect(() => {
    Create2MinerEngine.checkWebGPU().then((result) => {
      setStatus({
        supported: result.supported,
        message: result.supported ? '\u2705 WebGPU Ready' : `\u274C ${result.message}`,
        vendor: result.vendor,
      });
    });
  }, []);

  const startMining = useCallback(async (config: SafeConfig) => {
    if (miningState.isRunning) return;

    const engine = new Create2MinerEngine();
    engineRef.current = engine;

    await engine.start(
      { safeConfig: config, shaderCode: gnosisCreate2Shader },
      {
        onStateChange: (state: MinerState) => {
          setMiningState({
            isRunning: state.isRunning,
            isPaused: state.isPaused,
            totalHashes: state.totalHashes,
            hashrate: state.hashrate,
            elapsedTime: state.elapsedTime,
            bestNonce: state.bestNonce,
            bestAddress: state.bestAddress,
            error: state.error,
          });
          if (state.initializer) {
            setInitializer(state.initializer);
          }
        },
      },
    );
  }, [miningState.isRunning]);

  const stopMining = useCallback(() => {
    engineRef.current?.stop();
    setMiningState(prev => ({ ...prev, isRunning: false }));
  }, []);

  const pauseMining = useCallback(() => {
    engineRef.current?.pause();
  }, []);

  const resumeMining = useCallback(() => {
    engineRef.current?.resume();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
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
