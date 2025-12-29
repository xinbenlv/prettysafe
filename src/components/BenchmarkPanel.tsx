import { useEffect, useRef } from 'react';

interface BenchmarkPanelProps {
  webGPUStatus: {
    supported: boolean;
    message: string;
    vendor?: string;
  };
  duration: number;
  setDuration: (d: number) => void;
  isRunning: boolean;
  currentBenchmark: string;
  onStart: () => void;
  logs: string[];
}

export default function BenchmarkPanel({
  webGPUStatus,
  duration,
  setDuration,
  isRunning,
  currentBenchmark,
  onStart,
  logs,
}: BenchmarkPanelProps) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when logs change
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="space-y-6">
      {/* Status Card */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              webGPUStatus.supported ? 'bg-primary animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className={webGPUStatus.supported ? 'text-primary' : 'text-red-400'}>
            {webGPUStatus.message}
          </span>
        </div>
        {webGPUStatus.vendor && (
          <p className="text-white/50 text-sm mt-2 ml-6">
            GPU: {webGPUStatus.vendor}
          </p>
        )}
      </div>

      {/* Controls */}
      <div className="glass-card p-6">
        <div className="flex flex-wrap items-center gap-6">
          <div className="flex items-center gap-3">
            <label htmlFor="duration" className="text-white/80 font-medium">
              Duration (seconds):
            </label>
            <input
              id="duration"
              type="number"
              min={0.1}
              max={60}
              step={0.1}
              value={duration}
              onChange={(e) => setDuration(Math.max(0.1, Math.min(60, parseFloat(e.target.value) || 0.5)))}
              className="glass-input w-24 text-center"
              disabled={isRunning}
            />
          </div>

          <button
            onClick={onStart}
            disabled={isRunning || !webGPUStatus.supported}
            className="glass-button"
          >
            {isRunning ? (
              <span className="flex items-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle
                    className="opacity-25"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    strokeWidth="4"
                    fill="none"
                  />
                  <path
                    className="opacity-75"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  />
                </svg>
                Running {currentBenchmark}...
              </span>
            ) : (
              'Start Benchmark'
            )}
          </button>
        </div>
      </div>

      {/* Logs */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold mb-4 text-white/90">Benchmark Logs</h3>
        <div className="logs-panel bg-black/30 rounded-lg p-4 font-mono text-sm">
          {logs.length === 0 ? (
            <span className="text-white/40 italic">Benchmark logs will appear here...</span>
          ) : (
            logs.map((log, i) => (
              <div key={i} className="text-white/80">
                {log}
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      </div>
    </div>
  );
}
