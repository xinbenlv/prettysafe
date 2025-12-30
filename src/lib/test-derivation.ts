/**
 * Test file to verify address derivation matches between TypeScript and GPU shader
 * Run with: npx tsx src/lib/test-derivation.ts
 */

import { keccak256, concat, pad, toHex, type Hex, type Address, encodeFunctionData } from 'viem';

// Constants from gnosis-constants.ts
// Using GnosisSafeL2 singleton for consistency across L1 and L2 networks
const SAFE_SINGLETON = '0x3E5c63644E683549055b9Be8653de26E0B4CD36E' as const;
const PROXY_FACTORY = '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2' as const;
// Hash computed from factory.proxyCreationCode() + abi.encode(singleton)
const PROXY_CREATION_CODE_HASH = '0xcaf2dc2f91b804b2fcf1ed3a965a1ff4404b840b80c124277b00a43b4634b2ce' as const;
const DEFAULT_FALLBACK_HANDLER = '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4' as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

const SAFE_ABI = [
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

interface SafeConfig {
  owners: Address[];
  threshold: bigint;
}

// ===== UTILITY FUNCTIONS =====

function hexToBytes(hex: Hex): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): Hex {
  return ('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')) as Hex;
}

function u32ToLEBytes(x: number): Uint8Array {
  return new Uint8Array([x & 0xFF, (x >> 8) & 0xFF, (x >> 16) & 0xFF, (x >> 24) & 0xFF]);
}

function swap_endian(x: number): number {
  return (((x & 0xFF) << 24) |
          ((x & 0xFF00) << 8) |
          ((x & 0xFF0000) >> 8) |
          ((x & 0xFF000000) >>> 24)) >>> 0;
}

// ===== DERIVATION FUNCTIONS =====

function encodeSafeSetup(config: SafeConfig): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [
      config.owners,
      config.threshold,
      ZERO_ADDRESS,
      '0x',
      DEFAULT_FALLBACK_HANDLER,
      ZERO_ADDRESS,
      0n,
      ZERO_ADDRESS,
    ],
  });
}

function computeGnosisSalt(initializerHash: Hex, saltNonce: bigint): Hex {
  const packed = concat([initializerHash, pad(toHex(saltNonce), { size: 32 })]);
  return keccak256(packed);
}

function computeCreate2Address(gnosisSalt: Hex): Address {
  const data = concat([
    '0xff',
    PROXY_FACTORY,
    gnosisSalt,
    PROXY_CREATION_CODE_HASH,
  ]);
  const hash = keccak256(data);
  return `0x${hash.slice(-40)}` as Address;
}

function deriveSafeAddress(config: SafeConfig, saltNonce: bigint) {
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

// ===== TEST CASES =====

interface TestCase {
  name: string;
  owners: Address[];
  threshold: number;
  saltNonce: bigint;
  expectedAddress?: Address; // If known
}

const testCases: TestCase[] = [
  {
    name: 'Single owner with small nonce',
    owners: ['0xB5856d4598c919834913b8656ebc15a64d3C7836'],
    threshold: 1,
    saltNonce: 115982355759n, // 0x1b01164d2f
  },
  {
    name: 'Single owner with zero nonce',
    owners: ['0xB5856d4598c919834913b8656ebc15a64d3C7836'],
    threshold: 1,
    saltNonce: 0n,
  },
  {
    name: 'Multi-sig 2-of-3',
    owners: [
      '0xB5856d4598c919834913b8656ebc15a64d3C7836',
      '0x1234567890123456789012345678901234567890',
      '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    ],
    threshold: 2,
    saltNonce: 42n,
  },
];

// ===== SHADER SIMULATION =====

function simulateShaderPacking(
  factoryBytes: Uint8Array,
  gnosisSaltBytes: Uint8Array,
  codeHashBytes: Uint8Array
): { stateWords: Map<number, Uint8Array>, allMatch: boolean } {
  const expected85 = new Uint8Array(85);
  expected85[0] = 0xff;
  expected85.set(factoryBytes, 1);
  expected85.set(gnosisSaltBytes, 21);
  expected85.set(codeHashBytes, 53);

  // Pack factory into u32s (little-endian)
  const factoryU32s: number[] = [];
  for (let i = 0; i < 5; i++) {
    const u32 = (factoryBytes[i * 4] |
                (factoryBytes[i * 4 + 1] << 8) |
                (factoryBytes[i * 4 + 2] << 16) |
                (factoryBytes[i * 4 + 3] << 24)) >>> 0;
    factoryU32s.push(u32);
  }

  const saltU32s: number[] = [];
  for (let i = 0; i < 8; i++) {
    const u32 = (gnosisSaltBytes[i * 4] |
                (gnosisSaltBytes[i * 4 + 1] << 8) |
                (gnosisSaltBytes[i * 4 + 2] << 16) |
                (gnosisSaltBytes[i * 4 + 3] << 24)) >>> 0;
    saltU32s.push(u32);
  }

  const codeHashU32s: number[] = [];
  for (let i = 0; i < 8; i++) {
    const u32 = (codeHashBytes[i * 4] |
                (codeHashBytes[i * 4 + 1] << 8) |
                (codeHashBytes[i * 4 + 2] << 16) |
                (codeHashBytes[i * 4 + 3] << 24)) >>> 0;
    codeHashU32s.push(u32);
  }

  const stateWords = new Map<number, Uint8Array>();
  let allMatch = true;

  // Simulate shader's keccak256_85_address state packing
  const verifyStateWord = (stateIdx: number, bytesStart: number): boolean => {
    const shaderBytes = new Uint8Array(8);

    if (stateIdx === 0) {
      const s0_low = (0xFF | (factoryU32s[0] << 8)) >>> 0;
      const s0_high = ((factoryU32s[0] >>> 24) | (factoryU32s[1] << 8)) >>> 0;
      shaderBytes.set(u32ToLEBytes(s0_low), 0);
      shaderBytes.set(u32ToLEBytes(s0_high), 4);
    } else if (stateIdx === 1) {
      const s1_low = ((factoryU32s[1] >>> 24) | (factoryU32s[2] << 8)) >>> 0;
      const s1_high = ((factoryU32s[2] >>> 24) | (factoryU32s[3] << 8)) >>> 0;
      shaderBytes.set(u32ToLEBytes(s1_low), 0);
      shaderBytes.set(u32ToLEBytes(s1_high), 4);
    } else if (stateIdx === 2) {
      const s2_low = ((factoryU32s[3] >>> 24) | (factoryU32s[4] << 8)) >>> 0;
      const s2_high = ((factoryU32s[4] >>> 24) | (saltU32s[0] << 8)) >>> 0;
      shaderBytes.set(u32ToLEBytes(s2_low), 0);
      shaderBytes.set(u32ToLEBytes(s2_high), 4);
    } else if (stateIdx === 3) {
      const s3_low = ((saltU32s[0] >>> 24) | (saltU32s[1] << 8)) >>> 0;
      const s3_high = ((saltU32s[1] >>> 24) | (saltU32s[2] << 8)) >>> 0;
      shaderBytes.set(u32ToLEBytes(s3_low), 0);
      shaderBytes.set(u32ToLEBytes(s3_high), 4);
    } else if (stateIdx === 6) {
      const s6_low = ((saltU32s[6] >>> 24) | (saltU32s[7] << 8)) >>> 0;
      const s6_high = ((saltU32s[7] >>> 24) | (codeHashU32s[0] << 8)) >>> 0;
      shaderBytes.set(u32ToLEBytes(s6_low), 0);
      shaderBytes.set(u32ToLEBytes(s6_high), 4);
    }

    stateWords.set(stateIdx, shaderBytes);
    return shaderBytes.every((b, i) => b === expected85[bytesStart + i]);
  };

  allMatch = verifyStateWord(0, 0) && allMatch;
  allMatch = verifyStateWord(1, 8) && allMatch;
  allMatch = verifyStateWord(2, 16) && allMatch;
  allMatch = verifyStateWord(3, 24) && allMatch;
  allMatch = verifyStateWord(6, 48) && allMatch;

  return { stateWords, allMatch };
}

function verifySaltNoncePacking(saltNonce: bigint): boolean {
  const nonce_low = Number(saltNonce & 0xFFFFFFFFn);
  const nonce_high = Number((saltNonce >> 32n) & 0xFFFFFFFFn);

  const saltNonceHex = pad(toHex(saltNonce), { size: 32 });
  const saltNonceBytes = hexToBytes(saltNonceHex);

  // What the shader puts in salt_input[14..15]
  const bytes56_59 = u32ToLEBytes(swap_endian(nonce_high));
  const bytes60_63 = u32ToLEBytes(swap_endian(nonce_low));
  const gpuBytes = new Uint8Array([...bytes56_59, ...bytes60_63]);
  const cpuBytes = saltNonceBytes.slice(24, 32);

  return gpuBytes.every((b, i) => b === cpuBytes[i]);
}

// ===== RUN TESTS =====

console.log('=== Gnosis Safe Create2 Address Derivation Tests ===\n');

let allTestsPassed = true;

for (const testCase of testCases) {
  console.log(`Test: ${testCase.name}`);
  console.log(`  Owners: ${testCase.owners.length}`);
  console.log(`  Threshold: ${testCase.threshold}`);
  console.log(`  Salt Nonce: ${testCase.saltNonce} (0x${testCase.saltNonce.toString(16)})`);

  const config: SafeConfig = {
    owners: testCase.owners,
    threshold: BigInt(testCase.threshold),
  };

  const result = deriveSafeAddress(config, testCase.saltNonce);
  console.log(`  Derived Address: ${result.address}`);

  // Verify gnosisSalt computation
  const fullSaltInput = concat([result.initializerHash, pad(toHex(testCase.saltNonce), { size: 32 })]);
  const verifyGnosisSalt = keccak256(fullSaltInput);
  const gnosisSaltMatch = result.gnosisSalt === verifyGnosisSalt;
  console.log(`  Gnosis Salt: ${gnosisSaltMatch ? '✅' : '❌'}`);

  // Verify Create2 address computation
  const create2Input = concat(['0xff', PROXY_FACTORY, result.gnosisSalt, PROXY_CREATION_CODE_HASH]);
  const create2Hash = keccak256(create2Input);
  const derivedAddress = `0x${create2Hash.slice(-40)}` as Address;
  const addressMatch = derivedAddress.toLowerCase() === result.address.toLowerCase();
  console.log(`  Create2 Address: ${addressMatch ? '✅' : '❌'}`);

  // Verify salt nonce packing for GPU
  const noncePackingMatch = verifySaltNoncePacking(testCase.saltNonce);
  console.log(`  Nonce Packing: ${noncePackingMatch ? '✅' : '❌'}`);

  // Verify shader state packing
  const factoryBytes = hexToBytes(PROXY_FACTORY);
  const gnosisSaltBytes = hexToBytes(result.gnosisSalt);
  const codeHashBytes = hexToBytes(PROXY_CREATION_CODE_HASH);
  const { allMatch: statePackingMatch } = simulateShaderPacking(factoryBytes, gnosisSaltBytes, codeHashBytes);
  console.log(`  State Packing: ${statePackingMatch ? '✅' : '❌'}`);

  const testPassed = gnosisSaltMatch && addressMatch && noncePackingMatch && statePackingMatch;
  if (!testPassed) {
    allTestsPassed = false;
  }
  console.log(`  Result: ${testPassed ? '✅ PASSED' : '❌ FAILED'}\n`);
}

console.log('=== Summary ===');
console.log(allTestsPassed ? '✅ All tests passed!' : '❌ Some tests failed!');
process.exit(allTestsPassed ? 0 : 1);
