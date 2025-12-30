import { useState, useEffect, useCallback } from 'react';
import { type Address, type Hex } from 'viem';
import {
  connectWallet,
  getWalletState,
  deployProxy,
  waitForTransaction,
  isWalletAvailable,
  getExplorerTxLink,
  getSafeAppLink,
  switchToChain,
  getNetworkConfig,
  isSupportedNetwork,
  type WalletState,
} from '../lib/wallet';

interface DeployPanelProps {
  bestAddress: Address;
  bestNonce: bigint;
  initializer: Hex;
  selectedChainId: number;
}

type DeployStatus = 'idle' | 'connecting' | 'switching' | 'deploying' | 'confirming' | 'success' | 'error';

export default function DeployPanel({ bestAddress, bestNonce, initializer, selectedChainId }: DeployPanelProps) {
  const [walletState, setWalletState] = useState<WalletState>({
    connected: false,
    address: null,
    chainId: null,
    error: null,
  });
  const [deployStatus, setDeployStatus] = useState<DeployStatus>('idle');
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [deployedAddress, setDeployedAddress] = useState<Address | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Track previous props to detect changes
  const [prevBestAddress, setPrevBestAddress] = useState<Address>(bestAddress);
  const [prevBestNonce, setPrevBestNonce] = useState<bigint>(bestNonce);
  const [prevChainId, setPrevChainId] = useState<number>(selectedChainId);

  // Reset deploy state when props change (network, address, or nonce)
  useEffect(() => {
    const propsChanged =
      bestAddress !== prevBestAddress ||
      bestNonce !== prevBestNonce ||
      selectedChainId !== prevChainId;

    if (propsChanged) {
      // Reset deployment state when configuration changes
      if (deployStatus !== 'deploying' && deployStatus !== 'confirming') {
        setDeployStatus('idle');
        setError(null);
        setTxHash(null);
        setDeployedAddress(null);
      }
      setPrevBestAddress(bestAddress);
      setPrevBestNonce(bestNonce);
      setPrevChainId(selectedChainId);
    }
  }, [bestAddress, bestNonce, selectedChainId, prevBestAddress, prevBestNonce, prevChainId, deployStatus]);

  // Check wallet state on mount
  useEffect(() => {
    checkWallet();
  }, []);

  const checkWallet = async () => {
    const state = await getWalletState();
    setWalletState(state);
  };

  const handleConnect = useCallback(async () => {
    setDeployStatus('connecting');
    setError(null);

    const state = await connectWallet(selectedChainId);
    setWalletState(state);

    if (state.error) {
      setError(state.error);
      setDeployStatus('error');
    } else if (state.connected) {
      // Check if on selected network
      if (state.chainId !== selectedChainId) {
        setDeployStatus('switching');
        const switched = await switchToChain(selectedChainId);
        if (!switched) {
          setError(`Please switch to ${getNetworkConfig(selectedChainId)?.name || 'the selected network'}`);
          setDeployStatus('error');
          return;
        }
        // Re-check wallet state after switch
        await checkWallet();
      }
      setDeployStatus('idle');
    }
  }, [selectedChainId]);

  const handleSwitchNetwork = useCallback(async () => {
    setDeployStatus('switching');
    setError(null);

    const switched = await switchToChain(selectedChainId);
    if (!switched) {
      setError(`Failed to switch to ${getNetworkConfig(selectedChainId)?.name}. Please switch manually.`);
      setDeployStatus('error');
      return;
    }
    await checkWallet();
    setDeployStatus('idle');
  }, [selectedChainId]);

  const handleDeploy = useCallback(async () => {
    // Re-check wallet state before deploying (handles page refresh cases)
    const currentState = await getWalletState();
    setWalletState(currentState);

    if (!currentState.connected) {
      // Prompt user to connect
      setError('Wallet not connected. Please click "Connect Wallet" to continue.');
      setDeployStatus('idle');
      return;
    }

    if (currentState.chainId !== selectedChainId) {
      setError(`Please switch to ${getNetworkConfig(selectedChainId)?.name || 'the selected network'}`);
      setDeployStatus('idle');
      return;
    }

    setDeployStatus('deploying');
    setError(null);
    setTxHash(null);
    setDeployedAddress(null);

    try {
      const result = await deployProxy(initializer, bestNonce, bestAddress);
      setTxHash(result.txHash);
      setDeployedAddress(result.proxyAddress);
      setDeployStatus('confirming');

      // Wait for confirmation
      const receipt = await waitForTransaction(result.txHash);
      if (receipt.success) {
        setDeployStatus('success');
      } else {
        setError('Transaction failed');
        setDeployStatus('error');
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Deployment failed';

      // If wallet connection was lost, update state and show connect button
      if (message.includes('Wallet not connected') || message.includes('not initialized')) {
        await checkWallet();
        setError('Wallet connection lost. Please reconnect.');
      } else {
        setError(message);
      }
      setDeployStatus('error');
    }
  }, [initializer, bestNonce, selectedChainId]);

  const walletAvailable = isWalletAvailable();
  const isCorrectNetwork = walletState.chainId === selectedChainId;
  const canDeploy = walletState.connected && isCorrectNetwork && deployStatus !== 'deploying' && deployStatus !== 'confirming';
  const currentNetworkConfig = walletState.chainId ? getNetworkConfig(walletState.chainId) : null;
  const selectedNetworkConfig = getNetworkConfig(selectedChainId);

  return (
    <div className="glass-card p-6 border-primary/30">
      <h3 className="text-lg font-semibold mb-4 text-white/90">Deploy Safe</h3>

      <div className="space-y-4">
        {/* Wallet Connection */}
        {!walletAvailable ? (
          <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-lg p-4 text-yellow-200 text-sm">
            No Ethereum wallet detected. Please install MetaMask or another wallet to deploy.
          </div>
        ) : !walletState.connected ? (
          <button
            onClick={handleConnect}
            disabled={deployStatus === 'connecting'}
            className="glass-button w-full"
          >
            {deployStatus === 'connecting' ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Connecting...
              </span>
            ) : (
              'Connect Wallet'
            )}
          </button>
        ) : (
          <div className="bg-white/5 rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Connected Wallet</p>
                <p className="font-mono text-sm text-white/80">
                  {walletState.address?.slice(0, 6)}...{walletState.address?.slice(-4)}
                </p>
              </div>
              <div className={`px-3 py-1 rounded-full text-xs font-medium ${
                isCorrectNetwork
                  ? 'bg-primary/20 text-primary'
                  : 'bg-yellow-500/20 text-yellow-300'
              }`}>
                {currentNetworkConfig?.name || `Chain ${walletState.chainId}`}
              </div>
            </div>
          </div>
        )}

        {/* Network Warning */}
        {walletState.connected && !isCorrectNetwork && (
          <div className="bg-yellow-500/20 border border-yellow-500/50 rounded-lg p-4">
            <p className="text-yellow-200 text-sm mb-2">
              Please switch to {selectedNetworkConfig?.name || 'the selected network'} to deploy.
            </p>
            <button
              onClick={handleSwitchNetwork}
              disabled={deployStatus === 'switching'}
              className="text-yellow-300 text-sm underline hover:text-yellow-100"
            >
              {deployStatus === 'switching' ? 'Switching...' : `Switch to ${selectedNetworkConfig?.name}`}
            </button>
          </div>
        )}

        {/* Deploy Button */}
        {walletState.connected && (
          <button
            onClick={handleDeploy}
            disabled={!canDeploy}
            className="glass-button w-full bg-primary/20 hover:bg-primary/30 border-primary/50"
          >
            {deployStatus === 'deploying' ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Sending Transaction...
              </span>
            ) : deployStatus === 'confirming' ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
                Confirming...
              </span>
            ) : (
              `Deploy Safe on ${selectedNetworkConfig?.name || 'Network'}`
            )}
          </button>
        )}

        {/* Error Message */}
        {error && (
          <div className="bg-red-500/20 border border-red-500/50 rounded-lg p-3 text-red-300 text-sm">
            {error}
          </div>
        )}

        {/* Transaction Info */}
        {txHash && (
          <div className="bg-white/5 rounded-lg p-4 space-y-3">
            <div>
              <p className="text-white/50 text-xs uppercase tracking-wider mb-1">Transaction Hash</p>
              <a
                href={getExplorerTxLink(txHash, selectedChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-sm text-primary hover:text-primary-300 underline break-all"
              >
                {txHash}
              </a>
            </div>
          </div>
        )}

        {/* Success State */}
        {deployStatus === 'success' && deployedAddress && (
          <div className="bg-primary/20 border border-primary/50 rounded-lg p-4 space-y-4">
            <div className="flex items-center gap-2 text-primary">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
              <span className="font-semibold">Safe Deployed Successfully!</span>
            </div>

            <div>
              <p className="text-white/50 text-xs uppercase tracking-wider mb-2">Safe Address</p>
              <p className="font-mono text-sm text-white/90 break-all">{deployedAddress}</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <a
                href={getExplorerTxLink(txHash!, selectedChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-button text-center flex-1"
              >
                View on Explorer
              </a>
              <a
                href={getSafeAppLink(deployedAddress, selectedChainId)}
                target="_blank"
                rel="noopener noreferrer"
                className="glass-button text-center flex-1 bg-primary/20 hover:bg-primary/30 border-primary/50"
              >
                Open in Safe App
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
