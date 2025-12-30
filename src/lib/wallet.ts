import {
  createWalletClient,
  createPublicClient,
  custom,
  type WalletClient,
  type PublicClient,
  type Address,
  type Hex,
  type Chain,
} from 'viem';
import { mainnet } from 'viem/chains';
import {
  PROXY_FACTORY,
  PROXY_FACTORY_ABI,
  SAFE_SINGLETON,
  SUPPORTED_NETWORKS,
  COMING_SOON_NETWORKS,
  getNetworkConfig,
  isSupportedNetwork,
  isNetworkEnabled,
  type NetworkConfig,
} from './gnosis-constants';

// Extend window type for ethereum
declare global {
  interface Window {
    ethereum?: {
      request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
      on: (event: string, callback: (...args: unknown[]) => void) => void;
      removeListener: (event: string, callback: (...args: unknown[]) => void) => void;
      isMetaMask?: boolean;
    };
  }
}

export interface WalletState {
  connected: boolean;
  address: Address | null;
  chainId: number | null;
  error: string | null;
}

export interface DeployResult {
  txHash: Hex;
  proxyAddress: Address;
}

let walletClient: WalletClient | null = null;
let publicClient: PublicClient | null = null;
let currentChain: Chain = mainnet;

/**
 * Check if MetaMask or another Ethereum wallet is available.
 */
export function isWalletAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/**
 * Parse error message to get a user-friendly version.
 */
function parseErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'An unknown error occurred';
  }

  const message = error.message.toLowerCase();

  // User rejection patterns
  if (
    message.includes('user rejected') ||
    message.includes('user denied') ||
    message.includes('user cancelled') ||
    message.includes('rejected the request')
  ) {
    return 'Transaction was rejected by user';
  }

  // Insufficient funds
  if (message.includes('insufficient funds')) {
    return 'Insufficient funds for transaction';
  }

  // Network errors
  if (message.includes('network') || message.includes('disconnected')) {
    return 'Network error. Please check your connection.';
  }

  // Return first line of error message if it's too long
  const firstLine = error.message.split('\n')[0];
  if (firstLine.length > 100) {
    return firstLine.substring(0, 100) + '...';
  }

  return firstLine;
}

/**
 * Connect to the user's wallet.
 */
export async function connectWallet(targetChainId?: number): Promise<WalletState> {
  if (!isWalletAvailable()) {
    return {
      connected: false,
      address: null,
      chainId: null,
      error: 'No Ethereum wallet detected. Please install MetaMask.',
    };
  }

  try {
    // Request account access
    const accounts = (await window.ethereum!.request({
      method: 'eth_requestAccounts',
    })) as Address[];

    if (!accounts || accounts.length === 0) {
      return {
        connected: false,
        address: null,
        chainId: null,
        error: 'No accounts found. Please unlock your wallet.',
      };
    }

    // Get chain ID
    const chainIdHex = (await window.ethereum!.request({
      method: 'eth_chainId',
    })) as string;
    const chainId = parseInt(chainIdHex, 16);

    // Determine which chain to use
    const networkConfig = getNetworkConfig(targetChainId || chainId);
    currentChain = networkConfig?.chain || mainnet;

    // Create viem clients
    walletClient = createWalletClient({
      account: accounts[0],
      chain: currentChain,
      transport: custom(window.ethereum!),
    });

    publicClient = createPublicClient({
      chain: currentChain,
      transport: custom(window.ethereum!),
    });

    return {
      connected: true,
      address: accounts[0],
      chainId,
      error: null,
    };
  } catch (error: unknown) {
    return {
      connected: false,
      address: null,
      chainId: null,
      error: parseErrorMessage(error),
    };
  }
}

/**
 * Get current wallet state without prompting for connection.
 * Also initializes viem clients if the wallet is already connected.
 */
export async function getWalletState(): Promise<WalletState> {
  if (!isWalletAvailable()) {
    return {
      connected: false,
      address: null,
      chainId: null,
      error: null,
    };
  }

  try {
    const accounts = (await window.ethereum!.request({
      method: 'eth_accounts',
    })) as Address[];

    if (!accounts || accounts.length === 0) {
      // Clear clients if no accounts
      walletClient = null;
      publicClient = null;
      return {
        connected: false,
        address: null,
        chainId: null,
        error: null,
      };
    }

    const chainIdHex = (await window.ethereum!.request({
      method: 'eth_chainId',
    })) as string;
    const chainId = parseInt(chainIdHex, 16);

    // Initialize viem clients if not already done or if account/chain changed
    const needsClientInit = !walletClient ||
                            !publicClient ||
                            walletClient.account?.address?.toLowerCase() !== accounts[0].toLowerCase() ||
                            currentChain.id !== chainId;

    if (needsClientInit) {
      const networkConfig = getNetworkConfig(chainId);
      currentChain = networkConfig?.chain || mainnet;

      walletClient = createWalletClient({
        account: accounts[0],
        chain: currentChain,
        transport: custom(window.ethereum!),
      });

      publicClient = createPublicClient({
        chain: currentChain,
        transport: custom(window.ethereum!),
      });
    }

    return {
      connected: true,
      address: accounts[0],
      chainId,
      error: null,
    };
  } catch {
    return {
      connected: false,
      address: null,
      chainId: null,
      error: null,
    };
  }
}

/**
 * Update the viem clients for the current chain.
 */
export function updateClientsForChain(chainId: number): void {
  const networkConfig = getNetworkConfig(chainId);
  if (!networkConfig) return;

  currentChain = networkConfig.chain;

  if (walletClient && publicClient) {
    // Recreate clients with new chain
    walletClient = createWalletClient({
      account: walletClient.account!,
      chain: currentChain,
      transport: custom(window.ethereum!),
    });

    publicClient = createPublicClient({
      chain: currentChain,
      transport: custom(window.ethereum!),
    });
  }
}

/**
 * Deploy a Gnosis Safe proxy using the discovered nonce.
 */
export async function deployProxy(
  initializer: Hex,
  saltNonce: bigint,
  expectedAddress?: Address
): Promise<DeployResult> {
  if (!walletClient) {
    throw new Error('Wallet not connected');
  }

  if (!publicClient) {
    throw new Error('Public client not initialized');
  }

  // Check if the network is supported and enabled
  const chainId = currentChain.id;
  if (!isSupportedNetwork(chainId) || !isNetworkEnabled(chainId)) {
    throw new Error(`Deployment not yet supported on ${currentChain.name || 'this network'}`);
  }

  try {
    // Get the connected account
    const [account] = await walletClient.getAddresses();
    if (!account) {
      throw new Error('No account available');
    }

    // Check if a contract already exists at the expected address
    if (expectedAddress) {
      const code = await publicClient.getCode({ address: expectedAddress });
      if (code && code !== '0x') {
        throw new Error(
          `Safe already deployed at ${expectedAddress}. ` +
          `This address already exists on ${currentChain.name || 'this network'}. ` +
          `Use a different salt or check your existing Safe.`
        );
      }
    }

    // Simulate the transaction first to get the proxy address
    const { result: proxyAddress } = await publicClient.simulateContract({
      address: PROXY_FACTORY,
      abi: PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [SAFE_SINGLETON, initializer, saltNonce],
      account,
    });

    // Execute the transaction
    const txHash = await walletClient.writeContract({
      address: PROXY_FACTORY,
      abi: PROXY_FACTORY_ABI,
      functionName: 'createProxyWithNonce',
      args: [SAFE_SINGLETON, initializer, saltNonce],
      account,
      chain: currentChain,
    });

    return {
      txHash,
      proxyAddress,
    };
  } catch (error: unknown) {
    const message = parseErrorMessage(error);
    // Provide more specific error for Create2 failures
    if (message.includes('Create2 call failed') || message.includes('execution reverted')) {
      throw new Error(
        'Deployment failed. This usually means a Safe already exists at this address. ' +
        'Try mining a new salt or verify the address on the block explorer.'
      );
    }
    throw new Error(message);
  }
}

/**
 * Wait for a transaction to be confirmed.
 */
export async function waitForTransaction(txHash: Hex): Promise<{
  success: boolean;
  blockNumber: bigint | null;
}> {
  if (!publicClient) {
    throw new Error('Public client not initialized');
  }

  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
    });

    return {
      success: receipt.status === 'success',
      blockNumber: receipt.blockNumber,
    };
  } catch {
    return {
      success: false,
      blockNumber: null,
    };
  }
}

/**
 * Switch to a specific chain.
 */
export async function switchToChain(chainId: number): Promise<boolean> {
  if (!isWalletAvailable()) {
    return false;
  }

  const networkConfig = getNetworkConfig(chainId);
  if (!networkConfig) {
    return false;
  }

  try {
    await window.ethereum!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: `0x${chainId.toString(16)}` }],
    });
    updateClientsForChain(chainId);
    return true;
  } catch (switchError: unknown) {
    // If the chain hasn't been added to MetaMask, try adding it
    if ((switchError as { code?: number })?.code === 4902) {
      try {
        await window.ethereum!.request({
          method: 'wallet_addEthereumChain',
          params: [
            {
              chainId: `0x${chainId.toString(16)}`,
              chainName: networkConfig.name,
              nativeCurrency: networkConfig.chain.nativeCurrency,
              rpcUrls: [networkConfig.chain.rpcUrls.default.http[0]],
              blockExplorerUrls: [networkConfig.explorerUrl],
            },
          ],
        });
        updateClientsForChain(chainId);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}

/**
 * Generate block explorer link for a transaction.
 */
export function getExplorerTxLink(txHash: Hex, chainId: number): string {
  const networkConfig = getNetworkConfig(chainId);
  const explorerUrl = networkConfig?.explorerUrl || 'https://etherscan.io';
  return `${explorerUrl}/tx/${txHash}`;
}

/**
 * Generate Safe UI link for a deployed Safe.
 */
export function getSafeAppLink(address: Address, chainId: number): string {
  const networkConfig = getNetworkConfig(chainId);
  const prefix = networkConfig?.safeAppPrefix || 'eth';
  return `https://app.safe.global/home?safe=${prefix}:${address}`;
}

/**
 * Get list of enabled networks for UI (only networks where mining/deployment works).
 */
export function getEnabledNetworks(): Array<{ chainId: number; name: string }> {
  return Object.entries(SUPPORTED_NETWORKS)
    .filter(([, config]) => config.enabled)
    .map(([chainId, config]) => ({
      chainId: parseInt(chainId),
      name: config.name,
    }));
}

/**
 * Get list of coming soon networks for UI display.
 */
export function getComingSoonNetworks(): Array<{ chainId: number; name: string }> {
  return COMING_SOON_NETWORKS;
}

// Re-export for convenience
export { isSupportedNetwork, getNetworkConfig, isNetworkEnabled };
