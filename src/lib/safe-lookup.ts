import {
  createPublicClient,
  http,
  decodeFunctionData,
  type Address,
  type Hex,
} from 'viem';
import {
  PROXY_FACTORY,
  SAFE_SINGLETON,
  SAFE_ABI,
  SAFE_READONLY_ABI,
  PROXY_FACTORY_ABI,
  SUPPORTED_NETWORKS,
} from './gnosis-constants';
import { deriveSafeAddress } from './safe-encoder';

// --- Types ---

export interface SafeCreationData {
  created: string;
  creator: string;
  transactionHash: string;
  factoryAddress: string;
  masterCopy: string;
  setupData: string;
  dataDecoded: unknown;
}

export interface SafeLookupResult {
  owners: Address[];
  threshold: number;
  saltNonce: bigint | null;
  compatible: boolean;
  incompatibilityReason: string | null;
  derivedAddress: Address | null;
  sourceChainId: number;
  partial: boolean;
}

export type LookupError =
  | { type: 'not_found'; message: string }
  | { type: 'incompatible'; message: string }
  | { type: 'network_error'; message: string }
  | { type: 'parse_error'; message: string };

// --- Helper functions ---

export function getSafeServiceUrl(chainId: number): string | null {
  const config = SUPPORTED_NETWORKS[chainId];
  if (!config) return null;
  return `https://${config.safeServiceHost}`;
}

export async function fetchSafeCreationData(
  address: Address,
  chainId: number
): Promise<SafeCreationData> {
  const baseUrl = getSafeServiceUrl(chainId);
  if (!baseUrl) {
    throw { type: 'network_error', message: `Unsupported chain ID: ${chainId}` } as LookupError;
  }

  const url = `${baseUrl}/api/v1/safes/${address}/creation/`;
  const response = await fetch(url);

  if (response.status === 404) {
    throw { type: 'not_found', message: `Safe not found at ${address} on chain ${chainId}` } as LookupError;
  }

  if (!response.ok) {
    throw { type: 'network_error', message: `Safe Transaction Service returned ${response.status}` } as LookupError;
  }

  return response.json();
}

export function decodeSetupData(setupData: Hex): { owners: Address[]; threshold: bigint } {
  try {
    const decoded = decodeFunctionData({
      abi: SAFE_ABI,
      data: setupData,
    });

    const owners = decoded.args[0] as Address[];
    const threshold = decoded.args[1] as bigint;

    return { owners, threshold };
  } catch {
    throw { type: 'parse_error', message: 'Failed to decode Safe setup data' } as LookupError;
  }
}

function getPublicClient(chainId: number) {
  const config = SUPPORTED_NETWORKS[chainId];
  if (!config) return null;
  return createPublicClient({
    chain: config.chain,
    transport: http(),
  });
}

export async function extractSaltNonceFromTx(
  txHash: Hex,
  chainId: number
): Promise<bigint> {
  const client = getPublicClient(chainId);
  if (!client) {
    throw { type: 'network_error', message: `Unsupported chain ID: ${chainId}` } as LookupError;
  }

  try {
    const tx = await client.getTransaction({ hash: txHash });

    // Try to decode as createProxyWithNonce call
    const decoded = decodeFunctionData({
      abi: PROXY_FACTORY_ABI,
      data: tx.input,
    });

    // saltNonce is the 3rd argument
    return decoded.args[2] as bigint;
  } catch {
    throw {
      type: 'parse_error',
      message: 'Could not extract salt nonce from creation transaction. The Safe may have been created via a relayer or batched transaction.',
    } as LookupError;
  }
}

// --- On-chain fallback ---

async function readSafeOnChain(
  address: Address,
  chainId: number
): Promise<{ owners: Address[]; threshold: number } | null> {
  const client = getPublicClient(chainId);
  if (!client) return null;

  try {
    const [owners, threshold] = await Promise.all([
      client.readContract({
        address,
        abi: SAFE_READONLY_ABI,
        functionName: 'getOwners',
      }),
      client.readContract({
        address,
        abi: SAFE_READONLY_ABI,
        functionName: 'getThreshold',
      }),
    ]);

    return {
      owners: owners as Address[],
      threshold: Number(threshold),
    };
  } catch {
    return null;
  }
}

// --- Main entry point ---

export async function lookupSafe(
  address: Address,
  chainId: number
): Promise<SafeLookupResult> {
  let creationData: SafeCreationData;

  try {
    creationData = await fetchSafeCreationData(address, chainId);
  } catch (error) {
    const lookupErr = error as LookupError;

    // If not found on Transaction Service, try on-chain fallback
    if (lookupErr.type === 'not_found') {
      const onChainData = await readSafeOnChain(address, chainId);
      if (onChainData) {
        return {
          owners: onChainData.owners,
          threshold: onChainData.threshold,
          saltNonce: null,
          compatible: false,
          incompatibilityReason: 'Could not verify creation data from Safe Transaction Service. Salt nonce cannot be recovered — cross-chain deployment requires the exact salt nonce.',
          derivedAddress: null,
          sourceChainId: chainId,
          partial: true,
        };
      }
    }

    throw error;
  }

  // Verify factory address
  if (creationData.factoryAddress.toLowerCase() !== PROXY_FACTORY.toLowerCase()) {
    return {
      owners: [],
      threshold: 0,
      saltNonce: null,
      compatible: false,
      incompatibilityReason: `Incompatible factory: ${creationData.factoryAddress}. Expected ${PROXY_FACTORY}.`,
      derivedAddress: null,
      sourceChainId: chainId,
      partial: false,
    };
  }

  // Verify singleton
  if (creationData.masterCopy.toLowerCase() !== SAFE_SINGLETON.toLowerCase()) {
    return {
      owners: [],
      threshold: 0,
      saltNonce: null,
      compatible: false,
      incompatibilityReason: `Incompatible singleton: ${creationData.masterCopy}. Expected ${SAFE_SINGLETON} (GnosisSafeL2).`,
      derivedAddress: null,
      sourceChainId: chainId,
      partial: false,
    };
  }

  // Decode setup data
  const { owners, threshold } = decodeSetupData(creationData.setupData as Hex);

  // Extract salt nonce from creation transaction
  let saltNonce: bigint | null = null;
  try {
    saltNonce = await extractSaltNonceFromTx(creationData.transactionHash as Hex, chainId);
  } catch {
    // Salt nonce extraction failed — return partial result
    return {
      owners,
      threshold: Number(threshold),
      saltNonce: null,
      compatible: false,
      incompatibilityReason: 'Could not extract salt nonce from creation transaction. The Safe may have been created via a relayer or batched transaction.',
      derivedAddress: null,
      sourceChainId: chainId,
      partial: true,
    };
  }

  // Re-derive address and verify it matches
  const derived = deriveSafeAddress(
    { owners, threshold },
    saltNonce
  );

  if (derived.address.toLowerCase() !== address.toLowerCase()) {
    return {
      owners,
      threshold: Number(threshold),
      saltNonce,
      compatible: false,
      incompatibilityReason: `Address verification failed. Derived ${derived.address} but expected ${address}. This Safe may use non-standard setup parameters (custom fallback handler, payment fields, etc.).`,
      derivedAddress: derived.address,
      sourceChainId: chainId,
      partial: false,
    };
  }

  return {
    owners,
    threshold: Number(threshold),
    saltNonce,
    compatible: true,
    incompatibilityReason: null,
    derivedAddress: derived.address,
    sourceChainId: chainId,
    partial: false,
  };
}
