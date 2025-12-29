import { useState, useCallback } from 'react';
import GithubBanner from './components/GithubBanner';
import Header from './components/Header';
import BenchmarkPanel from './components/BenchmarkPanel';
import HashRateChart from './components/HashRateChart';
import Footer from './components/Footer';
import { useWebGPUBenchmark } from './hooks/useWebGPUBenchmark';
import { runEthersBenchmark } from './benchmarks/ethers-benchmark';
import { runViemBenchmark } from './benchmarks/viem-benchmark';

export interface BenchmarkResult {
  name: string;
  hashrate: number;
  color: string;
  unit: string;
}

function App() {
  const [duration, setDuration] = useState(0.5);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [currentBenchmark, setCurrentBenchmark] = useState<string>('');

  const { webGPUStatus, runWebGPUBenchmark } = useWebGPUBenchmark();

  const log = useCallback((msg: string) => {
    setLogs((prev) => [...prev, msg]);
    console.log(msg);
  }, []);

  const runAllBenchmarks = useCallback(async () => {
    setIsRunning(true);
    setLogs([]);
    setResults([]);

    try {
      // 1. ethers.js Benchmark
      setCurrentBenchmark('ethers.js');
      log(`Starting ethers.js CPU benchmark (${duration}s)...`);
      const ethersResult = await runEthersBenchmark(duration, log);
      setResults((prev) => [...prev, {
        name: 'ethers.js (CPU)',
        hashrate: ethersResult.hashrate,
        color: '#6366f1',
        unit: 'H/s',
      }]);
      log(`ethers.js: ${ethersResult.hashrate.toFixed(2)} H/s`);

      // 2. viem Benchmark
      setCurrentBenchmark('viem');
      log(`\nStarting viem CPU benchmark (${duration}s)...`);
      const viemResult = await runViemBenchmark(duration, log);
      setResults((prev) => [...prev, {
        name: 'viem (CPU)',
        hashrate: viemResult.hashrate,
        color: '#f59e0b',
        unit: 'H/s',
      }]);
      log(`viem: ${viemResult.hashrate.toFixed(2)} H/s`);

      // 3. WebGPU Benchmark
      setCurrentBenchmark('WebGPU');
      log(`\nStarting WebGPU benchmark (${duration}s)...`);
      const webgpuResult = await runWebGPUBenchmark(duration, log);
      if (webgpuResult) {
        setResults((prev) => [...prev, {
          name: 'WebGPU (GPU)',
          hashrate: webgpuResult.hashrate,
          color: '#1CD17D',
          unit: 'H/s',
        }]);
        log(`WebGPU: ${(webgpuResult.hashrate / 1e6).toFixed(2)} MH/s`);
      }

      log('\n✅ All benchmarks complete!');
    } catch (error: any) {
      log(`❌ Error: ${error.message}`);
    } finally {
      setIsRunning(false);
      setCurrentBenchmark('');
    }
  }, [duration, log, runWebGPUBenchmark]);

  return (
    <div className="min-h-screen flex flex-col">
      <GithubBanner />

      <main className="flex-1 max-w-4xl mx-auto w-full px-4 py-8 space-y-8">
        <Header />

        <BenchmarkPanel
          webGPUStatus={webGPUStatus}
          duration={duration}
          setDuration={setDuration}
          isRunning={isRunning}
          currentBenchmark={currentBenchmark}
          onStart={runAllBenchmarks}
          logs={logs}
        />

        {results.length > 0 && (
          <HashRateChart results={results} />
        )}
      </main>

      <Footer />
    </div>
  );
}

export default App;
