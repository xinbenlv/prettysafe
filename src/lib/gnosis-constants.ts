// Gnosis Safe v1.3.0 Constants
// These contracts are deployed at IDENTICAL addresses on all supported networks
// This allows users to deploy Safes to the same address across multiple chains

import { mainnet, base, arbitrum, optimism, polygon, gnosis, sepolia, baseSepolia, polygonMumbai } from 'viem/chains';
import { defineChain, type Chain } from 'viem';

// Robinhood Chain Testnet (Arbitrum Orbit L2, chain ID 46630)
export const robinhoodTestnet = defineChain({
  id: 46630,
  name: 'Robinhood Chain Testnet',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://rpc.testnet.chain.robinhood.com'] },
  },
  blockExplorers: {
    default: { name: 'Robinhood Explorer', url: 'https://explorer.testnet.chain.robinhood.com' },
  },
  testnet: true,
});

// Zero address for unused parameters
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

// The Proxy Factory contract - SAME on all networks
export const PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;

// Safe singleton (master copy) - GnosisSafeL2 for consistency across L1 and L2 networks
// Using 0x3E5c63644E683549055b9Be8653de26E0B4CD36E which is deployed on both Ethereum and Base
export const SAFE_SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' as const;

// keccak256 of the Safe Proxy creation code (including singleton address)
// Computed by: keccak256(factory.proxyCreationCode() ++ abi.encode(uint256(uint160(SAFE_SINGLETON))))
// The proxyCreationCode is fetched from the deployed factory contract
export const PROXY_CREATION_CODE_HASH = '0xcaf2dc2f91b804b2fcf1ed3a965a1ff4404b840b80c124277b00a43b4634b2ce' as const;

// Default Compatibility Fallback Handler - same on all networks
export const DEFAULT_FALLBACK_HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as const;

// Supported networks configuration
export interface NetworkConfig {
  chain: Chain;
  name: string;
  shortName: string;
  explorerUrl: string;
  safeAppPrefix: string;
  safeServiceHost: string;
  enabled: boolean;
  testnet?: boolean;
}

// Ethereum and Base are fully supported
// Both use the same Safe contract addresses - users get the same Safe address on both networks
export const SUPPORTED_NETWORKS: Record<number, NetworkConfig> = {
  [mainnet.id]: {
    chain: mainnet,
    name: 'Ethereum',
    shortName: 'eth',
    explorerUrl: 'https://etherscan.io',
    safeAppPrefix: 'eth',
    safeServiceHost: 'safe-transaction-mainnet.safe.global',
    enabled: true,
  },
  [base.id]: {
    chain: base,
    name: 'Base',
    shortName: 'base',
    explorerUrl: 'https://basescan.org',
    safeAppPrefix: 'base',
    safeServiceHost: 'safe-transaction-base.safe.global',
    enabled: false,
  },
  [arbitrum.id]: {
    chain: arbitrum,
    name: 'Arbitrum One',
    shortName: 'arb1',
    explorerUrl: 'https://arbiscan.io',
    safeAppPrefix: 'arb1',
    safeServiceHost: 'safe-transaction-arbitrum.safe.global',
    enabled: true,
  },
  [optimism.id]: {
    chain: optimism,
    name: 'Optimism',
    shortName: 'oeth',
    explorerUrl: 'https://optimistic.etherscan.io',
    safeAppPrefix: 'oeth',
    safeServiceHost: 'safe-transaction-optimism.safe.global',
    enabled: false,
  },
  [polygon.id]: {
    chain: polygon,
    name: 'Polygon',
    shortName: 'matic',
    explorerUrl: 'https://polygonscan.com',
    safeAppPrefix: 'matic',
    safeServiceHost: 'safe-transaction-polygon.safe.global',
    enabled: false,
  },
  [gnosis.id]: {
    chain: gnosis,
    name: 'Gnosis',
    shortName: 'gno',
    explorerUrl: 'https://gnosisscan.io',
    safeAppPrefix: 'gno',
    safeServiceHost: 'safe-transaction-gnosis.safe.global',
    enabled: false,
  },
  [sepolia.id]: {
    chain: sepolia,
    name: 'Sepolia',
    shortName: 'sep',
    explorerUrl: 'https://sepolia.etherscan.io',
    safeAppPrefix: 'sep',
    safeServiceHost: 'safe-transaction-sepolia.safe.global',
    enabled: false,
    testnet: true,
  },
  [baseSepolia.id]: {
    chain: baseSepolia,
    name: 'Base Sepolia',
    shortName: 'basesep',
    explorerUrl: 'https://sepolia.basescan.org',
    safeAppPrefix: 'basesep',
    safeServiceHost: 'safe-transaction-base-sepolia.safe.global',
    enabled: false,
    testnet: true,
  },
  [polygonMumbai.id]: {
    chain: polygonMumbai,
    name: 'Mumbai',
    shortName: 'mumbai',
    explorerUrl: 'https://mumbai.polygonscan.com',
    safeAppPrefix: 'mumbai',
    safeServiceHost: 'safe-transaction-mumbai.safe.global',
    enabled: false,
    testnet: true,
  },
  [robinhoodTestnet.id]: {
    chain: robinhoodTestnet,
    name: 'Robinhood Testnet',
    shortName: 'rhood',
    explorerUrl: 'https://explorer.testnet.chain.robinhood.com',
    safeAppPrefix: 'rhood',
    safeServiceHost: '',
    enabled: true,
  },
};

// Coming soon networks (for UI display only)
export const COMING_SOON_NETWORKS: { name: string; chainId: number }[] = [];

// Default to Base network
export const DEFAULT_CHAIN_ID = base.id;

export function getNetworkConfig(chainId: number): NetworkConfig | null {
  return SUPPORTED_NETWORKS[chainId] || null;
}

export function isSupportedNetwork(chainId: number): boolean {
  return chainId in SUPPORTED_NETWORKS;
}

export function isNetworkEnabled(chainId: number): boolean {
  const config = SUPPORTED_NETWORKS[chainId];
  return config?.enabled ?? false;
}

// Proxy Factory ABI (only the function we need)
export const PROXY_FACTORY_ABI = [
  {
    inputs: [
      { name: '_singleton', type: 'address' },
      { name: 'initializer', type: 'bytes' },
      { name: 'saltNonce', type: 'uint256' },
    ],
    name: 'createProxyWithNonce',
    outputs: [{ name: 'proxy', type: 'address' }],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;

// Safe read-only ABI for on-chain queries (fallback path)
export const SAFE_READONLY_ABI = [
  {
    inputs: [],
    name: 'getOwners',
    outputs: [{ name: '', type: 'address[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'getThreshold',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// Safe ABI (only the setup function)
export const SAFE_ABI = [
  {
    inputs: [
      { name: '_owners', type: 'address[]' },
      { name: '_threshold', type: 'uint256' },
      { name: 'to', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'fallbackHandler', type: 'address' },
      { name: 'paymentToken', type: 'address' },
      { name: 'payment', type: 'uint256' },
      { name: 'paymentReceiver', type: 'address' },
    ],
    name: 'setup',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const;
