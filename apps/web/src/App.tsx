import { useState, useCallback } from 'react';
import GithubBanner from './components/GithubBanner';
import Header from './components/Header';
import BenchmarkPanel from './components/BenchmarkPanel';
import HashRateChart from './components/HashRateChart';
import Footer from './components/Footer';
import SafeMinerPanel from './components/SafeMinerPanel';
import { useWebGPUBenchmark } from './hooks/useWebGPUBenchmark';
import { useTheme } from './hooks/useTheme';
import { runEthersBenchmark } from './benchmarks/ethers-benchmark';
import { runViemBenchmark } from './benchmarks/viem-benchmark';

export interface BenchmarkResult {
  name: string;
  hashrate: number;
  color: string;
  unit: string;
}

type AppMode = 'benchmark' | 'miner';

// Sun icon for light mode
function SunIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z" />
    </svg>
  );
}

// Moon icon for dark mode
function MoonIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z" />
    </svg>
  );
}

function App() {
  const [mode, setMode] = useState<AppMode>('miner');
  const [duration, setDuration] = useState(0.5);
  const [isRunning, setIsRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [results, setResults] = useState<BenchmarkResult[]>([]);
  const [currentBenchmark, setCurrentBenchmark] = useState<string>('');

  const { webGPUStatus, runWebGPUBenchmark } = useWebGPUBenchmark();
  const { theme, toggleTheme } = useTheme();

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
      {/* Header */}
      <header className="border-b border-surface sticky top-0 z-40" style={{ backgroundColor: 'var(--color-bg-header)' }}>
        <div className="max-w-4xl mx-auto w-full px-4 py-4 pr-24">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img
                src={theme === 'dark' ? '/logo-dark-transparent.png' : '/logo.png'}
                alt="PrettySafe"
                className="h-10 w-10"
              />
              <span className="text-2xl font-bold" style={{ color: 'var(--color-text-primary)' }}>PrettySafe</span>
            </div>

            {/* Theme Toggle */}
            <button
              onClick={toggleTheme}
              className="theme-toggle"
              title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {theme === 'dark' ? (
                <SunIcon className="w-5 h-5" />
              ) : (
                <MoonIcon className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </header>

      <GithubBanner />

      <main className="flex-1 max-w-4xl mx-auto w-full px-3 sm:px-4 py-4 sm:py-8 space-y-4 sm:space-y-8">
        {/* Hero Section */}
        <section className="text-center space-y-3 sm:space-y-4">
          <h1 className="heading-responsive text-3xl sm:text-4xl md:text-5xl font-bold" style={{ color: 'var(--color-text-primary)' }}>
            {mode === 'miner' ? 'Pretty Safe' : 'WebGPU Benchmark'}
          </h1>
          <p className="text-sm sm:text-base md:text-lg max-w-2xl mx-auto px-2" style={{ color: 'var(--color-text-secondary)' }}>
            {mode === 'miner'
              ? <>The World's first browser-Native WebGPU-powered Vanity Address Miner for Safe.<wbr />{' '}
               Mine locally with native GPU performance—Open Source, No Installs, and 100% Client-Side.<wbr />{' '}
               No CUDA or NVIDIA 5090 needed; works on every browser, from MacBooks to iPhones.</>
              : `Compare GPU-accelerated Keccak256 hashing performance against CPU-based Create2 address computation`}
          </p>

          {/* Mode Switcher - moved from header */}
          <div className="flex justify-center">
            <div className="glass-card p-1 inline-flex gap-1">
              <button
                onClick={() => setMode('miner')}
                className={`px-5 py-2 rounded-lg font-medium transition-all duration-300 text-sm ${
                  mode === 'miner'
                    ? 'bg-primary text-white'
                    : 'hover:bg-primary/10'
                }`}
                style={{ color: mode === 'miner' ? 'white' : 'var(--color-text-secondary)' }}
              >
                Safe Miner
              </button>
              <button
                onClick={() => setMode('benchmark')}
                className={`px-5 py-2 rounded-lg font-medium transition-all duration-300 text-sm ${
                  mode === 'benchmark'
                    ? 'bg-primary text-white'
                    : 'hover:bg-primary/10'
                }`}
                style={{ color: mode === 'benchmark' ? 'white' : 'var(--color-text-secondary)' }}
              >
                Benchmark
              </button>
            </div>
          </div>
        </section>

        {/* Content based on mode */}
        {mode === 'miner' ? (
          <SafeMinerPanel />
        ) : (
          <>
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
          </>
        )}
      </main>

      <Footer />
    </div>
  );
}

export default App;
