// ERC-8117 Compressed Display Format for Addresses
// https://eips.ethereum.org/EIPS/eip-8117

export const SUPERSCRIPTS: Record<string, string> = {
  '0': '\u2070', '1': '\u00B9', '2': '\u00B2', '3': '\u00B3', '4': '\u2074',
  '5': '\u2075', '6': '\u2076', '7': '\u2077', '8': '\u2078', '9': '\u2079'
};

export function toSuperscript(num: number): string {
  return String(num).split('').map(digit => SUPERSCRIPTS[digit] || digit).join('');
}

/**
 * ERC-8117: Compress consecutive identical hex characters.
 *
 * @param address - Ethereum address (with or without 0x prefix)
 * @param mode - 'unicode' uses superscript digits, 'ascii' uses {n} notation
 * @param truncate - If true, truncate with ellipsis for compact display
 */
export function compressAddressERC8117(
  address: string,
  mode: 'unicode' | 'ascii' = 'unicode',
  truncate: boolean = false
): string {
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
  const compressedBody = compressed;
  if (compressedBody.length <= 12) {
    return fullCompressed; // Too short to truncate
  }

  // Take first 6 chars of compressed body (after 0x) and last 4 chars of the original address
  const last4 = cleanAddress.slice(-4);
  return `0x${compressedBody.slice(0, 6)}...${last4}`;
}
