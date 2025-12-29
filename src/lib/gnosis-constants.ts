// Gnosis Safe v1.3.0 Mainnet Constants

// The Safe singleton (master copy) contract
export const SAFE_SINGLETON = '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552' as const;

// The Proxy Factory contract that deploys Safe proxies
export const PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;

// keccak256 of the Safe Proxy creation code
// This is used in the Create2 address derivation formula
export const PROXY_CREATION_CODE_HASH = '0x214690ce3643743477e6822c9f53e025f16956247c41551b9e0f63b4974f26b5' as const;

// Default Compatibility Fallback Handler
export const DEFAULT_FALLBACK_HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as const;

// Zero address for unused parameters
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

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
