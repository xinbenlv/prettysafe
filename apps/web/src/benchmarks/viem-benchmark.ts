import { getContractAddress, keccak256, toHex, pad, type Hex } from 'viem';

interface BenchmarkResult {
  hashrate: number;
  totalHashes: number;
  duration: number;
}

// Sample data for Create2 address computation
const DEPLOYER = '0x0000000000FFe8B47B3e2130213B802212439497' as Hex;
const BYTECODE = '0x600a600c600039600a6000f3602a60005260206000f3' as Hex;
const BYTECODE_HASH = keccak256(BYTECODE);

export async function runViemBenchmark(
  seconds: number,
  log: (msg: string) => void
): Promise<BenchmarkResult> {
  let totalHashes = 0;
  const startTime = performance.now();
  let lastLog = startTime;

  while (true) {
    const now = performance.now();
    if ((now - startTime) / 1000 >= seconds) break;

    // Compute Create2 address with varying salt
    const salt = pad(toHex(totalHashes), { size: 32 });
    getContractAddress({
      bytecodeHash: BYTECODE_HASH,
      from: DEPLOYER,
      opcode: 'CREATE2',
      salt,
    });

    totalHashes++;

    // Log progress every second
    if (now - lastLog >= 1000) {
      log(`... viem: ${totalHashes.toLocaleString()} addresses computed`);
      lastLog = now;
    }

    // Yield to event loop periodically to prevent UI freeze
    if (totalHashes % 1000 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  const duration = (performance.now() - startTime) / 1000;
  const hashrate = totalHashes / duration;

  log(`viem total: ${totalHashes.toLocaleString()} in ${duration.toFixed(2)}s`);

  return { hashrate, totalHashes, duration };
}
