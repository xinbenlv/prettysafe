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
import { PROXY_FACTORY, PROXY_FACTORY_ABI, SAFE_SINGLETON } from './gnosis-constants';

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

/**
 * Check if MetaMask or another Ethereum wallet is available.
 */
export function isWalletAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum;
}

/**
 * Connect to the user's wallet.
 */
export async function connectWallet(): Promise<WalletState> {
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

    // Create viem clients
    walletClient = createWalletClient({
      account: accounts[0],
      chain: mainnet,
      transport: custom(window.ethereum!),
    });

    publicClient = createPublicClient({
      chain: mainnet,
      transport: custom(window.ethereum!),
    });

    return {
      connected: true,
      address: accounts[0],
      chainId,
      error: null,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to connect wallet';
    return {
      connected: false,
      address: null,
      chainId: null,
      error: message,
    };
  }
}

/**
 * Get current wallet state without prompting for connection.
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
 * Deploy a Gnosis Safe proxy using the discovered nonce.
 */
export async function deployProxy(
  initializer: Hex,
  saltNonce: bigint
): Promise<DeployResult> {
  if (!walletClient) {
    throw new Error('Wallet not connected');
  }

  if (!publicClient) {
    throw new Error('Public client not initialized');
  }

  // Get the connected account
  const [account] = await walletClient.getAddresses();
  if (!account) {
    throw new Error('No account available');
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
  });

  return {
    txHash,
    proxyAddress,
  };
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
 * Switch to Ethereum mainnet.
 */
export async function switchToMainnet(): Promise<boolean> {
  if (!isWalletAvailable()) {
    return false;
  }

  try {
    await window.ethereum!.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x1' }],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate Etherscan link for a transaction.
 */
export function getEtherscanTxLink(txHash: Hex): string {
  return `https://etherscan.io/tx/${txHash}`;
}

/**
 * Generate Safe UI link for a deployed Safe.
 */
export function getSafeAppLink(address: Address): string {
  return `https://app.safe.global/home?safe=eth:${address}`;
}
