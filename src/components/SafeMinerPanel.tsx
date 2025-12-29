import { useState, useCallback } from 'react';
import { isAddress, type Address } from 'viem';
import { useSafeMiner, type MiningState, type WebGPUMinerStatus } from '../hooks/useSafeMiner';
import { countLeadingZeros, type SafeConfig } from '../lib/safe-encoder';
import DeployPanel from './DeployPanel';

function formatHashrate(hashrate: number): string {
  if (hashrate >= 1e9) return `${(hashrate / 1e9).toFixed(2)} GH/s`;
  if (hashrate >= 1e6) return `${(hashrate / 1e6).toFixed(2)} MH/s`;
  if (hashrate >= 1e3) return `${(hashrate / 1e3).toFixed(2)} KH/s`;
  return `${hashrate.toFixed(2)} H/s`;
}

function formatTime(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) return `${hrs}h ${mins}m ${secs}s`;
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function formatNumber(num: number): string {
  if (num >= 1e12) return `${(num / 1e12).toFixed(2)}T`;
  if (num >= 1e9) return `${(num / 1e9).toFixed(2)}B`;
  if (num >= 1e6) return `${(num / 1e6).toFixed(2)}M`;
  if (num >= 1e3) return `${(num / 1e3).toFixed(2)}K`;
  return num.toString();
}

export default function SafeMinerPanel() {
  const [ownersText, setOwnersText] = useState('');
  const [threshold, setThreshold] = useState(1);
  const [validationError, setValidationError] = useState<string | null>(null);

  const {
    status,
    miningState,
    initializer,
    startMining,
    stopMining,
  } = useSafeMiner();

  const parseOwners = useCallback((): Address[] | null => {
    const lines = ownersText
      .split(/[\n,]/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (lines.length === 0) {
      setValidationError('Please enter at least one owner address');
      return null;
    }

    const addresses: Address[] = [];
    for (const line of lines) {
      if (!isAddress(line)) {
        setValidationError(`Invalid address: ${line}`);
        return null;
      }
      addresses.push(line as Address);
    }

    // Check for duplicates
    const unique = new Set(addresses.map(a => a.toLowerCase()));
    if (unique.size !== addresses.length) {
      setValidationError('Duplicate addresses detected');
      return null;
    }

    return addresses;
  }, [ownersText]);

  const handleStart = useCallback(() => {
    setValidationError(null);
    const owners = parseOwners();
    if (!owners) return;

    if (threshold < 1 || threshold > owners.length) {
      setValidationError(`Threshold must be between 1 and ${owners.length}`);
      return;
    }

    const config: SafeConfig = {
      owners,
      threshold: BigInt(threshold),
    };

    startMining(config);
  }, [parseOwners, threshold, startMining]);

  const handleStop = useCallback(() => {
    stopMining();
  }, [stopMining]);

  const owners = ownersText
    .split(/[\n,]/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  return (
    <div className="space-y-6">
      {/* WebGPU Status */}
      <div className="glass-card p-6">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              status.supported ? 'bg-primary animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className={status.supported ? 'text-primary' : 'text-red-400'}>
            {status.message}
          </span>
        </div>
        {status.vendor && (
          <p className="text-white/50 text-sm mt-2 ml-6">
            GPU: {status.vendor}
          </p>
        )}
      </div>

      {/* Safe Configuration */}
      <div className="glass-card p-6">
        <h3 className="text-lg font-semibold mb-4 text-white/90">Safe Configuration</h3>

        <div className="space-y-4">
          {/* Owners Input */}
          <div>
            <label htmlFor="owners" className="block text-white/80 font-medium mb-2">
              Owner Addresses
            </label>
            <textarea
              id="owners"
              value={ownersText}
              onChange={(e) => setOwnersText(e.target.value)}
              placeholder="Enter owner addresses (one per line or comma-separated)&#10;0x1234...&#10;0x5678..."
              className="glass-input w-full h-32 resize-none font-mono text-sm"
              disabled={miningState.isRunning}
            />
            <p className="text-white/40 text-xs mt-1">
              {owners.length} address{owners.length !== 1 ? 'es' : ''} entered
            </p>
          </div>

          {/* Threshold Input */}
          <div className="flex items-center gap-4">
            <label htmlFor="threshold" className="text-white/80 font-medium">
              Threshold:
            </label>
            <input
              id="threshold"
              type="number"
              min={1}
              max={Math.max(1, owners.length)}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, parseInt(e.target.value) || 1))}
              className="glass-input w-20 text-center"
              disabled={miningState.isRunning}
            />
            <span className="text-white/50 text-sm">
              of {Math.max(1, owners.length)} owner{owners.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Validation Error */}
          {validationError && (
            <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-300 text-sm">
              {validationError}
            </div>
          )}

          {/* Mining Error */}
          {miningState.error && (
            <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-300 text-sm">
              {miningState.error}
            </div>
          )}

          {/* Control Buttons */}
          <div className="flex gap-4">
            <button
              onClick={handleStart}
              disabled={miningState.isRunning || !status.supported}
              className="glass-button flex-1"
            >
              {miningState.isRunning ? (
                <span className="flex items-center justify-center gap-2">
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
                  Mining...
                </span>
              ) : (
                'Start Mining'
              )}
            </button>

            {miningState.isRunning && (
              <button
                onClick={handleStop}
                className="glass-button bg-red-500/20 hover:bg-red-500/30 border-red-500/50"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mining Statistics */}
      {(miningState.isRunning || miningState.totalHashes > 0) && (
        <div className="glass-card p-6">
          <h3 className="text-lg font-semibold mb-4 text-white/90">Mining Progress</h3>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="bg-white/5 rounded-lg p-4">
              <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Hashrate</p>
              <p className="text-xl font-bold text-primary">
                {formatHashrate(miningState.hashrate)}
              </p>
            </div>

            <div className="bg-white/5 rounded-lg p-4">
              <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Total Hashes</p>
              <p className="text-xl font-bold text-white">
                {formatNumber(miningState.totalHashes)}
              </p>
            </div>

            <div className="bg-white/5 rounded-lg p-4">
              <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Elapsed Time</p>
              <p className="text-xl font-bold text-white">
                {formatTime(miningState.elapsedTime)}
              </p>
            </div>

            <div className="bg-white/5 rounded-lg p-4">
              <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Status</p>
              <p className={`text-xl font-bold ${miningState.isRunning ? 'text-primary' : 'text-white/50'}`}>
                {miningState.isRunning ? 'Running' : 'Stopped'}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Best Result */}
      {miningState.bestAddress && (
        <div className="glass-card p-6 border-primary/30">
          <h3 className="text-lg font-semibold mb-4 text-white/90">Best Result Found</h3>

          <div className="space-y-4">
            <div>
              <p className="text-white/50 text-xs uppercase tracking-wider mb-2">Address</p>
              <div className="bg-black/30 rounded-lg p-4 font-mono text-lg break-all">
                <span className="text-primary">
                  {miningState.bestAddress.slice(0, 2 + countLeadingZeros(miningState.bestAddress))}
                </span>
                <span className="text-white/80">
                  {miningState.bestAddress.slice(2 + countLeadingZeros(miningState.bestAddress))}
                </span>
              </div>
              <p className="text-white/40 text-sm mt-2">
                {countLeadingZeros(miningState.bestAddress)} leading zeros
              </p>
            </div>

            <div>
              <p className="text-white/50 text-xs uppercase tracking-wider mb-2">Salt Nonce</p>
              <div className="bg-black/30 rounded-lg p-4 font-mono text-sm break-all text-white/80">
                {miningState.bestNonce?.toString()}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Deploy Panel */}
      {miningState.bestAddress && miningState.bestNonce !== null && initializer && (
        <DeployPanel
          bestAddress={miningState.bestAddress}
          bestNonce={miningState.bestNonce}
          initializer={initializer}
        />
      )}
    </div>
  );
}
