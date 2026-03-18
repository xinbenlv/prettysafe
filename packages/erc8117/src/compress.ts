// ERC-8117 Compressed Display Format for Addresses
// https://eips.ethereum.org/EIPS/eip-8117
//
// Compresses leading zero nibbles after 0x prefix using subscript notation.
// Trigger: n >= 4 consecutive leading zero nibbles.
// Example: 0x0000000071727De2... → 0x0₇71727De2... (unicode) or 0x0(7)71727De2... (ascii)

export const SUBSCRIPTS: Record<string, string> = {
  '0': '\u2080', '1': '\u2081', '2': '\u2082', '3': '\u2083', '4': '\u2084',
  '5': '\u2085', '6': '\u2086', '7': '\u2087', '8': '\u2088', '9': '\u2089'
};

export function toSubscript(num: number): string {
  return String(num).split('').map(digit => SUBSCRIPTS[digit] || digit).join('');
}

/**
 * Count leading zero nibbles in an address (after 0x prefix).
 */
function countLeadingZeroNibbles(hex: string): number {
  let count = 0;
  for (const char of hex) {
    if (char === '0') count++;
    else break;
  }
  return count;
}

/**
 * ERC-8117: Compress leading zero nibbles in an Ethereum address.
 *
 * Per the spec, only leading zeros after 0x are compressed, and only
 * when there are 4 or more consecutive zero nibbles.
 *
 * @param address - Ethereum address (with or without 0x prefix)
 * @param mode - 'unicode' uses subscript digits (0₇), 'ascii' uses parentheses 0(7)
 * @param truncate - If true, truncate the suffix with ellipsis for compact display
 */
export function compressAddressERC8117(
  address: string,
  mode: 'unicode' | 'ascii' = 'unicode',
  truncate: boolean = false
): string {
  const cleanAddress = address.startsWith('0x') ? address.slice(2) : address;
  const leadingZeros = countLeadingZeroNibbles(cleanAddress);

  // Only compress if 4+ leading zero nibbles
  if (leadingZeros < 4) {
    if (!truncate) return `0x${cleanAddress}`;
    return truncateAddress(`0x${cleanAddress}`);
  }

  const remainder = cleanAddress.slice(leadingZeros);
  let compressed: string;

  if (mode === 'unicode') {
    compressed = `0x0${toSubscript(leadingZeros)}${remainder}`;
  } else {
    compressed = `0x0(${leadingZeros})${remainder}`;
  }

  if (!truncate) return compressed;

  // Truncated: keep compressed prefix + ... + last 4 chars of original
  if (compressed.length <= 14) return compressed;
  const last4 = cleanAddress.slice(-4);
  // Show enough of the compressed start to include the subscript + some context
  const prefixEnd = mode === 'unicode' ? 4 + toSubscript(leadingZeros).length : 4 + String(leadingZeros).length + 2;
  const prefix = compressed.slice(0, prefixEnd + 4); // subscript + 4 hex chars
  return `${prefix}...${last4}`;
}

function truncateAddress(address: string): string {
  if (address.length < 14) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
