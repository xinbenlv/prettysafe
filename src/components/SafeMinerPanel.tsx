import { useState, useCallback, useMemo, useEffect } from 'react';
import { isAddress, getAddress, type Address, type Hex } from 'viem';
import { useSafeMiner } from '../hooks/useSafeMiner';
import { countLeadingZeros, deriveSafeAddress, type SafeConfig } from '../lib/safe-encoder';
import { getEnabledNetworks, getComingSoonNetworks, connectWallet, getWalletState, isWalletAvailable, type WalletState } from '../lib/wallet';
import { PROXY_FACTORY, PROXY_CREATION_CODE_HASH } from '../lib/gnosis-constants';
import DeployPanel from './DeployPanel';
import ConfirmModal from './ConfirmModal';
import Jazzicon from './Jazzicon';

// Default placeholder address for demo/testing when no wallet is connected
export const DEFAULT_DEMO_OWNER = '0x0123456789abcdef0123456789abcdef01234567' as Address;

// Network logos as inline SVG components
function EthereumLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 256 417" xmlns="http://www.w3.org/2000/svg">
      <path fill="#343434" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z"/>
      <path fill="#8C8C8C" d="M127.962 0L0 212.32l127.962 75.639V154.158z"/>
      <path fill="#3C3C3B" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z"/>
      <path fill="#8C8C8C" d="M127.962 416.905v-104.72L0 236.585z"/>
      <path fill="#141414" d="M127.961 287.958l127.96-75.637-127.96-58.162z"/>
      <path fill="#393939" d="M0 212.32l127.96 75.638v-133.8z"/>
    </svg>
  );
}

function BaseLogo({ className = "w-5 h-5" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 111 111" xmlns="http://www.w3.org/2000/svg">
      <circle cx="55.5" cy="55.5" r="55.5" fill="#0052FF"/>
      <path d="M55.3733 91.2C75.1623 91.2 91.2 75.1623 91.2 55.3733C91.2 35.5843 75.1623 19.5466 55.3733 19.5466C36.5962 19.5466 21.2095 33.9687 19.6 52.3733H66.6133V58.3733H19.6C21.2095 76.7779 36.5962 91.2 55.3733 91.2Z" fill="white"/>
    </svg>
  );
}

function NetworkLogo({ chainId, className = "w-5 h-5" }: { chainId: number; className?: string }) {
  switch (chainId) {
    case 1:
      return <EthereumLogo className={className} />;
    case 8453:
      return <BaseLogo className={className} />;
    default:
      return <div className={`${className} bg-gray-500 rounded-full`} />;
  }
}

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

// ERC-8117 Compressed Display Format for Addresses
// https://eips.ethereum.org/EIPS/eip-8117
const SUPERSCRIPTS: Record<string, string> = {
  '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074',
  '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079'
};

function toSuperscript(num: number): string {
  return String(num).split('').map(digit => SUPERSCRIPTS[digit] || digit).join('');
}

// ERC-8117: Compress consecutive identical hex characters
function compressAddressERC8117(address: string, mode: 'unicode' | 'ascii' = 'unicode', truncate: boolean = false): string {
  // Remove 0x prefix for processing
  const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;

  // Find and compress sequences of 6+ identical characters
  const compressed = cleanAddress.replace(/(.)\1{5,}/g, (match) => {
    const char = match[0];
    const length = match.length;

    if (mode === 'unicode') {
      return `${char}${toSuperscript(length)}`;
    } else {
      return `${char}{${length}}`;
    }
  });

  const fullCompressed = `0x${compressed}`;

  if (!truncate) {
    return fullCompressed;
  }

  // For truncated format: show first part (including any compression) + ... + last 4 chars
  // We need to find where the compressed prefix ends and show some context after it
  // Strategy: show up to 10 chars after 0x, then ..., then last 4 chars of original address
  const compressedBody = compressed;
  if (compressedBody.length <= 12) {
    return fullCompressed; // Too short to truncate
  }

  // Take first 6 chars of compressed body (after 0x) and last 4 chars of the original address
  const last4 = cleanAddress.slice(-4);
  return `0x${compressedBody.slice(0, 6)}...${last4}`;
}

// Truncated address format: 0x<first 4>...<last 4>
function truncateAddress(address: string): string {
  if (address.length < 12) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// Format salt nonce as hex string with 0x prefix (trim leading zeros for readability)
function formatSaltHex(salt: bigint): string {
  if (salt === 0n) return '0x0';
  const hex = salt.toString(16);
  return '0x' + hex;
}

// Copy icon component
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

// Paste icon component
function PasteIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
      <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
    </svg>
  );
}

export default function SafeMinerPanel() {
  const [ownersText, setOwnersText] = useState('');
  const [threshold, setThreshold] = useState(1);
  const [selectedChainId, setSelectedChainId] = useState(8453); // Default to Base
  const [saltInput, setSaltInput] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const [copyFeedback, setCopyFeedback] = useState(false);
  const [walletState, setWalletState] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    error: null,
  });
  const [isConnecting, setIsConnecting] = useState(false);
  const [showDemoAddressModal, setShowDemoAddressModal] = useState(false);
  const [usingDemoAddress, setUsingDemoAddress] = useState(false);

  // Track the locked target zeros for 90% countdown
  // Only updates when: 1) we find more zeros, or 2) we've done 50%+ of predicted hashes
  const [lockedTargetZeros, setLockedTargetZeros] = useState<number>(1);
  const [hashesAtLock, setHashesAtLock] = useState<number>(0);

  const enabledNetworks = getEnabledNetworks();
  const comingSoonNetworks = getComingSoonNetworks();

  const {
    status,
    miningState,
    initializer,
    startMining,
    stopMining,
  } = useSafeMiner();

  // Check wallet state on mount
  useEffect(() => {
    const checkWallet = async () => {
      const state = await getWalletState();
      setWalletState(state);
      // Auto-populate owner address if wallet is connected and no owners entered yet
      if (state.connected && state.address && !ownersText.trim()) {
        setOwnersText(state.address);
        setThreshold(1);
      }
    };
    checkWallet();
  }, []);

  // Handle wallet connection
  const handleConnectWallet = useCallback(async () => {
    setIsConnecting(true);
    try {
      const state = await connectWallet(selectedChainId);
      setWalletState(state);
      // Auto-populate owner address when connected
      if (state.connected && state.address) {
        // Only set if empty or if the current text doesn't include the address
        if (!ownersText.trim() || !ownersText.toLowerCase().includes(state.address.toLowerCase())) {
          setOwnersText(prev => {
            if (!prev.trim()) return state.address!;
            // Add to existing addresses
            return `${state.address}\n${prev}`;
          });
        }
        setThreshold(1);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [selectedChainId, ownersText]);

  // Update salt input when a better result is found
  useEffect(() => {
    if (miningState.bestNonce !== null) {
      setSaltInput(formatSaltHex(miningState.bestNonce));
    }
  }, [miningState.bestNonce]);

  // Update locked target zeros for 90% countdown
  // Only updates when: 1) we find more zeros, or 2) we've done 50%+ of predicted hashes
  useEffect(() => {
    if (!miningState.isRunning) {
      // Reset when mining stops
      setLockedTargetZeros(1);
      setHashesAtLock(0);
      return;
    }

    const currentZeros = miningState.bestAddress ? countLeadingZeros(miningState.bestAddress) : 0;
    const newTargetZeros = currentZeros + 1;

    // Case 1: Found more zeros than current target - update immediately
    if (newTargetZeros > lockedTargetZeros) {
      setLockedTargetZeros(newTargetZeros);
      setHashesAtLock(miningState.totalHashes);
      return;
    }

    // Case 2: Check if we've done 50%+ of predicted hashes since last lock
    const hashesFor90Percent = Math.log(10) * Math.pow(16, lockedTargetZeros);
    const hashesSinceLock = miningState.totalHashes - hashesAtLock;
    const progressSinceLock = hashesSinceLock / hashesFor90Percent;

    if (progressSinceLock >= 0.5 && newTargetZeros !== lockedTargetZeros) {
      // We've done 50%+ of predicted hashes, update the target
      setLockedTargetZeros(newTargetZeros);
      setHashesAtLock(miningState.totalHashes);
    }
  }, [miningState.isRunning, miningState.bestAddress, miningState.totalHashes, lockedTargetZeros, hashesAtLock]);

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

  // Proceed with mining after validation/confirmation
  const proceedWithMining = useCallback((ownersList: Address[]) => {
    if (threshold < 1 || threshold > ownersList.length) {
      setValidationError(`Threshold must be between 1 and ${ownersList.length}`);
      return;
    }

    const config: SafeConfig = {
      owners: ownersList,
      threshold: BigInt(threshold),
    };

    startMining(config);
  }, [threshold, startMining]);

  // Handle confirming demo address modal
  const handleConfirmDemoAddress = useCallback(() => {
    setShowDemoAddressModal(false);
    setOwnersText(DEFAULT_DEMO_OWNER);
    setUsingDemoAddress(true);
    setThreshold(1);

    // Start mining with the demo address
    proceedWithMining([DEFAULT_DEMO_OWNER]);
  }, [proceedWithMining]);

  const handleStart = useCallback(() => {
    setValidationError(null);

    // Check if no owner is entered and wallet is not connected
    const currentOwners = ownersText
      .split(/[\n,]/)
      .map(line => line.trim())
      .filter(line => line.length > 0);

    if (currentOwners.length === 0 && !walletState.connected) {
      // Show the demo address confirmation modal
      setShowDemoAddressModal(true);
      return;
    }

    const owners = parseOwners();
    if (!owners) return;

    // Track if using demo address
    const isDemoAddress = owners.length === 1 &&
      owners[0].toLowerCase() === DEFAULT_DEMO_OWNER.toLowerCase();
    setUsingDemoAddress(isDemoAddress);

    proceedWithMining(owners);
  }, [parseOwners, ownersText, walletState.connected, proceedWithMining]);

  const handleStop = useCallback(() => {
    stopMining();
  }, [stopMining]);

  const owners = ownersText
    .split(/[\n,]/)
    .map(line => line.trim())
    .filter(line => line.length > 0);

  // Parse salt input (supports both number and 0x hex format)
  const parsedSalt = useMemo((): { valid: boolean; value: bigint | null; error: string | null } => {
    const trimmed = saltInput.trim();
    if (!trimmed) {
      return { valid: false, value: null, error: null };
    }

    try {
      if (trimmed.startsWith('0x') || trimmed.startsWith('0X')) {
        // Hex format - can be up to 32 bytes (64 hex chars)
        const hexPart = trimmed.slice(2);
        if (!/^[0-9a-fA-F]+$/.test(hexPart)) {
          return { valid: false, value: null, error: 'Invalid hex characters' };
        }
        if (hexPart.length > 64) {
          return { valid: false, value: null, error: 'Hex value too large (max 32 bytes)' };
        }
        const value = BigInt(trimmed);
        return { valid: true, value, error: null };
      } else {
        // Decimal number format
        if (!/^[0-9]+$/.test(trimmed)) {
          return { valid: false, value: null, error: 'Invalid number format' };
        }
        const value = BigInt(trimmed);
        // Check if within reasonable range (256-bit max)
        if (value < 0n || value >= 2n ** 256n) {
          return { valid: false, value: null, error: 'Number out of range' };
        }
        return { valid: true, value, error: null };
      }
    } catch {
      return { valid: false, value: null, error: 'Invalid salt format' };
    }
  }, [saltInput]);

  // Compute address from salt and owners
  const computedResult = useMemo((): {
    address: Address | null;
    nonce: bigint | null;
    initializer: Hex | null;
  } => {
    if (!parsedSalt.valid || parsedSalt.value === null) {
      return { address: null, nonce: null, initializer: null };
    }

    const parsedOwners = owners.filter(o => isAddress(o)) as Address[];
    if (parsedOwners.length === 0) {
      return { address: null, nonce: null, initializer: null };
    }

    const effectiveThreshold = Math.min(threshold, parsedOwners.length);
    if (effectiveThreshold < 1) {
      return { address: null, nonce: null, initializer: null };
    }

    try {
      const config: SafeConfig = {
        owners: parsedOwners,
        threshold: BigInt(effectiveThreshold),
      };
      const result = deriveSafeAddress(config, parsedSalt.value);
      return {
        address: result.address,
        nonce: parsedSalt.value,
        initializer: result.initializer,
      };
    } catch {
      return { address: null, nonce: null, initializer: null };
    }
  }, [parsedSalt, owners, threshold]);

  // Copy salt to clipboard
  const handleCopySalt = useCallback(async () => {
    if (saltInput) {
      try {
        await navigator.clipboard.writeText(saltInput);
        setCopyFeedback(true);
        setTimeout(() => setCopyFeedback(false), 2000);
      } catch {
        console.error('Failed to copy to clipboard');
      }
    }
  }, [saltInput]);

  // Paste from clipboard
  const handlePasteSalt = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      setSaltInput(text.trim());
    } catch {
      console.error('Failed to paste from clipboard');
    }
  }, []);

  // Determine the active result (mined or from salt input)
  const activeResult = useMemo(() => {
    // If we have a mined result, use it
    if (miningState.bestAddress && miningState.bestNonce !== null && initializer) {
      return {
        address: miningState.bestAddress,
        nonce: miningState.bestNonce,
        initializer: initializer,
        source: 'mined' as const,
      };
    }
    // Otherwise use computed result from salt input
    if (computedResult.address && computedResult.nonce !== null && computedResult.initializer) {
      return {
        address: computedResult.address,
        nonce: computedResult.nonce,
        initializer: computedResult.initializer,
        source: 'custom' as const,
      };
    }
    return null;
  }, [miningState.bestAddress, miningState.bestNonce, initializer, computedResult]);

  const walletAvailable = isWalletAvailable();

  // Check if currently using demo address
  const isCurrentlyUsingDemoAddress = useMemo(() => {
    const currentOwners = ownersText
      .split(/[\n,]/)
      .map(line => line.trim().toLowerCase())
      .filter(line => line.length > 0);
    return currentOwners.length === 1 &&
      currentOwners[0] === DEFAULT_DEMO_OWNER.toLowerCase();
  }, [ownersText]);

  return (
    <div className="space-y-6">
      {/* Demo Address Warning Modal */}
      <ConfirmModal
        isOpen={showDemoAddressModal}
        title="Use Demo Address?"
        message={
          <div className="space-y-3">
            <p>
              No wallet is connected and no owner address is entered.
            </p>
            <p>
              A <strong>demo address</strong> will be used as the default owner:
            </p>
            <code className="block bg-surface-inner px-3 py-2 rounded-lg text-xs font-mono break-all">
              {DEFAULT_DEMO_OWNER.slice(0, 20)}...{DEFAULT_DEMO_OWNER.slice(-8)}
            </code>
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-800 text-left">
              <p className="font-medium text-sm">⚠️ Warning</p>
              <p className="text-xs mt-1">
                This is a placeholder address for demonstration only.
                <strong> Do NOT use it for actual deployment</strong> — you won't have access to the deployed Safe!
              </p>
            </div>
          </div>
        }
        confirmText="Use Demo Address & Mine"
        cancelText="Cancel"
        variant="warning"
        onConfirm={handleConfirmDemoAddress}
        onCancel={() => setShowDemoAddressModal(false)}
      />
      {/* Prominent Connect Wallet Button */}
      {walletAvailable && !walletState.connected && (
        <button
          onClick={handleConnectWallet}
          disabled={isConnecting}
          className="w-full card p-6 border-2 border-primary/30 hover:border-primary hover:shadow-glow transition-all cursor-pointer group"
        >
          <div className="flex items-center justify-center gap-4">
            <div className="w-12 h-12 rounded-full bg-primary/10 flex items-center justify-center group-hover:bg-primary/20 transition-colors">
              <svg className="w-6 h-6 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div className="text-left">
              <p className="text-xl font-semibold text-primary-themed group-hover:text-primary transition-colors">
                {isConnecting ? 'Connecting...' : 'Connect Wallet'}
              </p>
              <p className="text-secondary-themed text-sm">
                Connect to auto-fill your address as Safe owner
              </p>
            </div>
            {isConnecting && (
              <svg className="animate-spin h-6 w-6 text-primary" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
              </svg>
            )}
          </div>
        </button>
      )}

      {/* Connected Wallet Info */}
      {walletState.connected && walletState.address && (
        <div className="card p-4 border border-primary/30 bg-primary/5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/20 flex items-center justify-center">
                <svg className="w-5 h-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div>
                <p className="text-secondary-themed text-xs uppercase tracking-wider">Connected Wallet</p>
                <p className="font-mono text-sm text-primary-themed">
                  {walletState.address.slice(0, 6)}...{walletState.address.slice(-4)}
                </p>
              </div>
            </div>
            <div className="px-3 py-1 rounded-full bg-primary/20 text-primary text-xs font-medium">
              ✓ Connected
            </div>
          </div>
        </div>
      )}

      {/* No Wallet Available Warning */}
      {!walletAvailable && (
        <div className="card p-4 border-amber-500/50" style={{ backgroundColor: 'rgba(251, 191, 36, 0.1)', borderColor: 'rgba(251, 191, 36, 0.3)' }}>
          <div className="flex items-start gap-3">
            <svg className="w-6 h-6 text-amber-500 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="space-y-2">
              <p className="text-amber-500 font-medium">No Wallet Detected</p>
              <p className="text-amber-500/80 text-sm">
                Connecting a wallet is optional—it's a convenience feature that streamlines deployment.
                You can still mine salt without connecting, and use the mined salt manually via Etherscan,
                developer CLI, or other deployment tools.
              </p>
              <p className="text-amber-500/70 text-xs mt-2">
                To deploy directly from this app, install MetaMask or another Ethereum wallet.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* GPU Status */}
      <div className="card p-4">
        <div className="flex items-center gap-3">
          <div
            className={`w-3 h-3 rounded-full ${
              status.supported ? 'bg-primary animate-pulse' : 'bg-red-500'
            }`}
          />
          <span className="text-primary-themed">
            {status.supported ? '✅ WebGPU Ready' : '❌ WebGPU Not Available'}
          </span>
        </div>
        {status.vendor && (
          <p className="text-secondary-themed text-sm mt-2 ml-6">GPU: {status.vendor}</p>
        )}
      </div>

      {/* Configuration */}
      <div className="card">
        <h3 className="text-lg font-semibold mb-4 text-primary-themed">Safe Configuration</h3>

        <div className="space-y-4">
          {/* Owners */}
          <div>
            <label htmlFor="owners" className="block text-primary-themed font-medium mb-2">
              Owner Addresses
            </label>
            <textarea
              id="owners"
              value={ownersText}
              onChange={(e) => setOwnersText(e.target.value)}
              placeholder="Enter owner addresses (one per line or comma-separated)&#10;0x1234...&#10;0x5678..."
              className="input w-full h-32 resize-none font-mono text-sm"
              disabled={miningState.isRunning}
            />
            <p className="text-secondary-themed text-xs mt-1">{owners.length} address{owners.length !== 1 ? 'es' : ''} entered</p>
          </div>

          {/* Threshold */}
          <div className="flex items-center gap-4">
            <label htmlFor="threshold" className="text-primary-themed font-medium">
              Threshold:
            </label>
            <input
              id="threshold"
              type="number"
              min="1"
              max={Math.max(1, owners.length)}
              value={threshold}
              onChange={(e) => setThreshold(Math.max(1, parseInt(e.target.value) || 1))}
              className="input w-20 text-center"
              disabled={miningState.isRunning}
            />
            <span className="text-secondary-themed text-sm">
              of {Math.max(1, owners.length)} owner{owners.length !== 1 ? 's' : ''}
            </span>
          </div>

          {/* Network Selection with Logos */}
          <div>
            <label className="block text-primary-themed font-medium mb-2">
              Deploy Network
            </label>
            <div className="flex flex-wrap gap-1.5 sm:gap-2">
              {enabledNetworks.map((network: { chainId: number; name: string }) => (
                <button
                  key={network.chainId}
                  type="button"
                  onClick={() => setSelectedChainId(network.chainId)}
                  disabled={miningState.isRunning}
                  className={`network-btn flex items-center gap-1.5 sm:gap-2 px-2.5 py-2 sm:px-4 sm:py-3 rounded-lg sm:rounded-xl border transition-all text-xs sm:text-sm ${
                    selectedChainId === network.chainId
                      ? 'bg-primary/10 border-primary text-primary-themed'
                      : 'bg-button-inactive border-surface text-secondary-themed hover:border-primary/50'
                  } ${miningState.isRunning ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}
                >
                  <NetworkLogo chainId={network.chainId} className="network-logo w-4 h-4 sm:w-5 sm:h-5" />
                  <span>{network.name}</span>
                </button>
              ))}
              {comingSoonNetworks.map((network: { chainId: number; name: string }) => (
                <button
                  key={network.chainId}
                  type="button"
                  disabled
                  className="network-btn flex items-center gap-1.5 sm:gap-2 px-2.5 py-2 sm:px-4 sm:py-3 rounded-lg sm:rounded-xl border bg-button-inactive border-surface text-secondary-themed opacity-50 cursor-not-allowed text-xs sm:text-sm"
                  title="Coming Soon"
                >
                  <div className="network-logo w-4 h-4 sm:w-5 sm:h-5 bg-surface-inner rounded-full" style={{ backgroundColor: 'var(--color-surface-border)' }} />
                  <span>{network.name}</span>
                  <span className="text-[10px] sm:text-xs">(Soon)</span>
                </button>
              ))}
            </div>
            <p className="text-secondary-themed text-xs mt-2">
              Same address can be deployed on both Ethereum and Base
            </p>
          </div>

          {/* Contract Info - Deployer & Init Code Hash */}
          <div className="bg-surface-inner rounded-xl p-4 space-y-3 border border-surface">
            <div>
              <p className="text-secondary-themed text-xs uppercase tracking-wider mb-1">Proxy Factory (Deployer)</p>
              <p className="font-mono text-xs text-primary-themed break-all">{PROXY_FACTORY}</p>
            </div>
            <div>
              <p className="text-secondary-themed text-xs uppercase tracking-wider mb-1">Init Code Hash</p>
              <p className="font-mono text-xs text-primary-themed break-all">{PROXY_CREATION_CODE_HASH}</p>
            </div>
          </div>

          {/* Unified Salt Input with Mining Button */}
          <div className="border-t border-surface pt-4 mt-4 pb-16 sm:pb-0">
            <label htmlFor="salt" className="block text-primary-themed font-medium mb-2">
              Salt {miningState.bestNonce !== null ? '(Mined)' : '(Custom)'}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  id="salt"
                  type="text"
                  value={saltInput}
                  onChange={(e) => setSaltInput(e.target.value)}
                  placeholder="Enter salt or mine for vanity address..."
                  className="input w-full font-mono text-sm pr-20"
                  disabled={miningState.isRunning}
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex gap-1">
                  <button
                    onClick={handlePasteSalt}
                    disabled={miningState.isRunning}
                    className="p-2 text-secondary-themed hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                    title="Paste from clipboard"
                  >
                    <PasteIcon className="w-4 h-4" />
                  </button>
                  <button
                    onClick={handleCopySalt}
                    disabled={!saltInput}
                    className="p-2 text-secondary-themed hover:text-primary hover:bg-primary/10 rounded transition-colors disabled:opacity-50"
                    title="Copy to clipboard"
                  >
                    {copyFeedback ? (
                      <span className="text-primary text-xs">✓</span>
                    ) : (
                      <CopyIcon className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
              {/* Mining Toggle Button - Desktop only (hidden on mobile) */}
              <button
                onClick={miningState.isRunning ? handleStop : handleStart}
                disabled={!status.supported}
                className={`hidden sm:flex px-6 py-2 rounded-full font-medium transition-all whitespace-nowrap items-center gap-2 ${
                  miningState.isRunning
                    ? 'bg-amber-500 hover:bg-amber-600 text-white'
                    : 'bg-primary hover:shadow-glow-lg text-white shadow-glow'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {miningState.isRunning ? (
                  <>
                    <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Stop
                  </>
                ) : (
                  'Mine'
                )}
              </button>
            </div>
            <p className="text-secondary-themed text-xs mt-1">
              {miningState.isRunning
                ? 'Mining for vanity address...'
                : miningState.bestNonce !== null
                ? `Mined result • Decimal: ${miningState.bestNonce.toString()}`
                : 'Enter a salt or click Mine to find a vanity address'}
            </p>
            {parsedSalt.error && (
              <p className="text-red-500 text-xs mt-1">{parsedSalt.error}</p>
            )}
          </div>

          {/* Computed Address Display - Highlighted with pink when found */}
          {activeResult && (
            <div className={`rounded-2xl p-4 border-2 transition-all ${
              activeResult.source === 'mined'
                ? 'border-secondary bg-secondary/10 shadow-pink-glow'
                : 'border-primary/30 bg-primary/5'
            }`}>
              <div className="flex items-center justify-between mb-2">
                <p className="text-secondary-themed text-xs uppercase tracking-wider">
                  {activeResult.source === 'mined' ? 'Mined Address' : 'Computed Address'}
                </p>
                {activeResult.source === 'mined' && (
                  <span className="px-2 py-1 rounded-full bg-secondary text-white text-xs font-medium">
                    ✨ Vanity Found!
                  </span>
                )}
              </div>
              {/* ERC-55 Checksummed Address Display */}
              {(() => {
                const checksummedAddress = getAddress(activeResult.address);
                const leadingZerosCount = countLeadingZeros(activeResult.address);
                return (
                  <div className="font-mono text-sm sm:text-lg break-all">
                    <span className="text-primary font-bold">
                      {checksummedAddress.slice(0, 2 + leadingZerosCount)}
                    </span>
                    <span className="text-primary-themed">
                      {checksummedAddress.slice(2 + leadingZerosCount)}
                    </span>
                  </div>
                );
              })()}
              <p className="text-secondary-themed text-xs mt-2">
                {countLeadingZeros(activeResult.address)} leading zeros •{' '}
                <a
                  href="https://eips.ethereum.org/EIPS/eip-55"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:text-primary underline decoration-dotted"
                >
                  ERC-55
                </a>{' '}
                checksummed
              </p>

              {/* Display Formats Section */}
              <div className="mt-3 sm:mt-4 pt-3 sm:pt-4 border-t border-current/10">
                <p className="text-secondary-themed text-[10px] sm:text-xs uppercase tracking-wider mb-2 sm:mb-3">Display Formats</p>
                <div className="space-y-1.5 sm:space-y-2">
                  {/* Truncated Format - ERC-55 checksummed */}
                  <div className="flex items-center gap-2 sm:gap-3 bg-surface-inner/50 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2">
                    <span className="text-secondary-themed text-[10px] sm:text-xs w-16 sm:w-24 flex-shrink-0">Truncated</span>
                    <code className="font-mono text-xs sm:text-sm text-primary-themed">
                      {truncateAddress(getAddress(activeResult.address))}
                    </code>
                  </div>

                  {/* ERC-8117 Unicode Format (Truncated) - uses ERC-55 checksummed address */}
                  <div className="flex items-center gap-2 sm:gap-3 bg-surface-inner/50 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2">
                    <span className="text-secondary-themed text-[10px] sm:text-xs w-16 sm:w-24 flex-shrink-0">
                      <a
                        href="https://eips.ethereum.org/EIPS/eip-8117"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary underline decoration-dotted"
                      >
                        ERC-8117
                      </a>
                    </span>
                    <code className="font-mono text-xs sm:text-sm text-primary-themed">
                      {compressAddressERC8117(getAddress(activeResult.address), 'unicode', true)}
                    </code>
                  </div>

                  {/* ERC-8117 ASCII Format (Truncated) - uses ERC-55 checksummed address */}
                  <div className="flex items-center gap-2 sm:gap-3 bg-surface-inner/50 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2">
                    <span className="text-secondary-themed text-[10px] sm:text-xs w-16 sm:w-24 flex-shrink-0">
                      <a
                        href="https://eips.ethereum.org/EIPS/eip-8117"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary underline decoration-dotted"
                      >
                        ERC-8117
                      </a>
                      <span className="hidden sm:inline"> ASCII</span>
                    </span>
                    <code className="font-mono text-xs sm:text-sm text-primary-themed">
                      {compressAddressERC8117(getAddress(activeResult.address), 'ascii', true)}
                    </code>
                  </div>

                  {/* Jazzicon - deterministic identicon based on address */}
                  <div className="flex items-center gap-2 sm:gap-3 bg-surface-inner/50 rounded-lg px-2 sm:px-3 py-1.5 sm:py-2">
                    <span className="text-secondary-themed text-[10px] sm:text-xs w-16 sm:w-24 flex-shrink-0">
                      <a
                        href="https://github.com/MetaMask/jazzicon"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary underline decoration-dotted"
                      >
                        Jazzicon
                      </a>
                    </span>
                    <div className="flex items-center gap-2">
                      <Jazzicon address={activeResult.address} diameter={20} className="sm:hidden" />
                      <Jazzicon address={activeResult.address} diameter={24} className="hidden sm:block" />
                      <span className="text-secondary-themed text-[10px] sm:text-xs hidden sm:inline">Deterministic identicon</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Validation Error */}
          {validationError && (
            <div className="rounded-xl p-3 text-sm" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.3)', border: '1px solid', color: '#ef4444' }}>
              {validationError}
            </div>
          )}

          {/* Mining Error */}
          {miningState.error && (
            <div className="rounded-xl p-3 text-sm" style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.3)', border: '1px solid', color: '#ef4444' }}>
              {miningState.error}
            </div>
          )}

        </div>
      </div>

      {/* Mining Statistics */}
      {(miningState.isRunning || miningState.totalHashes > 0) && (
        <div className="card">
          <h3 className="text-lg font-semibold mb-4 text-primary-themed">Mining Progress</h3>

          <div className="mining-stats-grid grid grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
            <div className="bg-surface-inner rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-surface">
              <p className="text-secondary-themed text-[10px] sm:text-xs uppercase tracking-wider mb-1">Hashrate</p>
              <p className="stat-value text-base sm:text-xl font-bold text-primary">
                {formatHashrate(miningState.hashrate)}
              </p>
            </div>

            <div className="bg-surface-inner rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-surface">
              <p className="text-secondary-themed text-[10px] sm:text-xs uppercase tracking-wider mb-1">Total Hashes</p>
              <p className="stat-value text-base sm:text-xl font-bold text-primary-themed">
                {formatNumber(miningState.totalHashes)}
              </p>
            </div>

            <div className="bg-surface-inner rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-surface">
              <p className="text-secondary-themed text-[10px] sm:text-xs uppercase tracking-wider mb-1">Elapsed Time</p>
              <p className="stat-value text-base sm:text-xl font-bold text-primary-themed">
                {formatTime(miningState.elapsedTime)}
              </p>
            </div>

            <div className="bg-surface-inner rounded-xl sm:rounded-2xl p-3 sm:p-4 border border-surface">
              <p className="text-secondary-themed text-[10px] sm:text-xs uppercase tracking-wider mb-1">90% Chance</p>
              {(() => {
                const currentZeros = miningState.bestAddress ? countLeadingZeros(miningState.bestAddress) : 0;
                // Use locked target zeros - only updates when we find more zeros or exceed 50% of predicted hashes
                const targetZeros = lockedTargetZeros;
                // For 90% probability: hashes = ln(10) * 16^targetZeros ≈ 2.303 * 16^targetZeros
                // This is derived from: P(success) = 1 - (1-p)^k where p = 1/16^n
                const hashesFor90Percent = Math.log(10) * Math.pow(16, targetZeros);

                // Calculate remaining hashes needed (from hashesAtLock, not total)
                const hashesSinceLock = miningState.totalHashes - hashesAtLock;
                const remainingHashes = Math.max(0, hashesFor90Percent - hashesSinceLock);
                // Time estimate based on remaining hashes and current hashrate
                const remainingSeconds = miningState.hashrate > 0 ? remainingHashes / miningState.hashrate : Infinity;
                // Check if we've exceeded the 90% threshold (overdue)
                const isOverdue = hashesSinceLock > hashesFor90Percent;
                // Progress percentage since lock
                const progressPercent = Math.min(100, (hashesSinceLock / hashesFor90Percent) * 100);

                return (
                  <>
                    <p className={`stat-value text-base sm:text-xl font-bold ${isOverdue ? 'text-secondary' : 'text-primary-themed'}`}>
                      {miningState.hashrate > 0
                        ? isOverdue
                          ? `+${formatTime((hashesSinceLock - hashesFor90Percent) / miningState.hashrate)}`
                          : formatTime(remainingSeconds)
                        : '—'}
                    </p>
                    <p className="text-secondary-themed text-[10px] sm:text-xs mt-1">
                      {formatNumber(hashesSinceLock)} / {formatNumber(hashesFor90Percent)} ({progressPercent.toFixed(0)}%)
                    </p>
                    <p className="text-secondary-themed text-[10px] sm:text-xs">
                      Target: {targetZeros} zeros (current: {currentZeros})
                    </p>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      )}

      {/* Deploy Panel */}
      {activeResult && (
        <DeployPanel
          bestAddress={activeResult.address}
          bestNonce={activeResult.nonce}
          initializer={activeResult.initializer}
          selectedChainId={selectedChainId}
          usingDemoAddress={isCurrentlyUsingDemoAddress}
        />
      )}

      {/* Floating Mine/Stop Button - Mobile only */}
      <div 
        className="fixed bottom-0 left-0 right-0 p-3 sm:hidden z-50 
                   flex justify-center
                   transition-all duration-300 ease-in-out
                   animate-in slide-in-from-bottom-4"
        style={{ 
          paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))',
        }}
      >
        <button
          onClick={miningState.isRunning ? handleStop : handleStart}
          disabled={!status.supported}
          className={`w-1/2 min-w-[140px] max-w-[200px] py-3 rounded-full font-semibold text-sm transition-all duration-300 
                     flex items-center justify-center gap-2
                     ${miningState.isRunning
                       ? 'bg-amber-500 hover:bg-amber-600 text-white shadow-lg shadow-amber-500/30'
                       : 'bg-primary hover:shadow-glow-lg text-white shadow-glow'
                     } disabled:opacity-50 disabled:cursor-not-allowed`}
        >
          {miningState.isRunning ? (
            <>
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z" />
              </svg>
              Stop
            </>
          ) : (
            <>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
              Mine
            </>
          )}
        </button>
      </div>
    </div>
  );
}
