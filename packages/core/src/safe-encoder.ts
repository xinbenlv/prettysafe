import { encodeFunctionData, keccak256, concat, pad, toHex, type Hex, type Address } from 'viem';
import {
  SAFE_SINGLETON,
  PROXY_FACTORY,
  PROXY_CREATION_CODE_HASH,
  DEFAULT_FALLBACK_HANDLER,
  ZERO_ADDRESS,
  SAFE_ABI,
} from './gnosis-constants';

export interface SafeConfig {
  owners: Address[];
  threshold: bigint;
}

/**
 * Encodes the Safe setup() calldata with the given owners and threshold.
 * Uses standard defaults for other parameters.
 */
export function encodeSafeSetup(config: SafeConfig): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [
      config.owners,
      config.threshold,
      ZERO_ADDRESS, // to
      '0x', // data
      DEFAULT_FALLBACK_HANDLER, // fallbackHandler
      ZERO_ADDRESS, // paymentToken
      0n, // payment
      ZERO_ADDRESS, // paymentReceiver
    ],
  });
}

/**
 * Computes the Gnosis salt used in Create2 address derivation.
 * gnosisSalt = keccak256(abi.encodePacked(keccak256(initializer), saltNonce))
 */
export function computeGnosisSalt(initializerHash: Hex, saltNonce: bigint): Hex {
  // Pack initializerHash (32 bytes) + saltNonce (32 bytes)
  const packed = concat([initializerHash, pad(toHex(saltNonce), { size: 32 })]);
  return keccak256(packed);
}

/**
 * Computes the Create2 address for a Gnosis Safe proxy.
 * address = keccak256(0xff ++ factory ++ gnosisSalt ++ proxyCreationCodeHash)[12:]
 */
export function computeCreate2Address(gnosisSalt: Hex): Address {
  const data = concat([
    '0xff',
    PROXY_FACTORY,
    gnosisSalt,
    PROXY_CREATION_CODE_HASH,
  ]);
  const hash = keccak256(data);
  // Take last 20 bytes (40 hex chars + 0x prefix)
  return `0x${hash.slice(-40)}` as Address;
}

/**
 * Full pipeline: given Safe config and saltNonce, compute the derived address.
 */
export function deriveSafeAddress(config: SafeConfig, saltNonce: bigint): {
  initializer: Hex;
  initializerHash: Hex;
  gnosisSalt: Hex;
  address: Address;
} {
  const initializer = encodeSafeSetup(config);
  const initializerHash = keccak256(initializer);
  const gnosisSalt = computeGnosisSalt(initializerHash, saltNonce);
  const address = computeCreate2Address(gnosisSalt);

  return {
    initializer,
    initializerHash,
    gnosisSalt,
    address,
  };
}

/**
 * Compare two addresses numerically (as BigInt).
 * Returns true if a < b.
 */
export function isAddressSmaller(a: Address, b: Address): boolean {
  return BigInt(a) < BigInt(b);
}

/**
 * Convert address to BigInt for numerical comparison.
 */
export function addressToBigInt(address: Address): bigint {
  return BigInt(address);
}

/**
 * Get the number of leading zeros in an address (for display purposes).
 */
export function countLeadingZeros(address: Address): number {
  const hex = address.slice(2); // Remove 0x prefix
  let count = 0;
  for (const char of hex) {
    if (char === '0') {
      count++;
    } else {
      break;
    }
  }
  return count;
}

/**
 * Prepare data for WebGPU shader.
 * Returns typed arrays ready for GPU buffers.
 */
export function prepareShaderData(config: SafeConfig): {
  initializerHash: Uint8Array;
  factoryAddress: Uint8Array;
  proxyCodeHash: Uint8Array;
} {
  const initializer = encodeSafeSetup(config);
  const initializerHash = keccak256(initializer);

  // Convert hex strings to Uint8Array (remove 0x prefix)
  const hexToBytes = (hex: Hex): Uint8Array => {
    const bytes = new Uint8Array((hex.length - 2) / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
    }
    return bytes;
  };

  return {
    initializerHash: hexToBytes(initializerHash),
    factoryAddress: hexToBytes(PROXY_FACTORY),
    proxyCodeHash: hexToBytes(PROXY_CREATION_CODE_HASH),
  };
}
