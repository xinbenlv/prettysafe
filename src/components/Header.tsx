export default function Header() {
  return (
    <header className="text-center space-y-4">
      <h1 className="text-4xl md:text-5xl font-bold bg-gradient-to-r from-primary via-primary-300 to-primary bg-clip-text text-transparent">
        WebGPU Create2 Benchmark
      </h1>
      <p className="text-white/60 text-lg max-w-2xl mx-auto">
        Compare GPU-accelerated Keccak256 hashing performance against CPU-based
        Create2 address computation using ethers.js and viem
      </p>
    </header>
  );
}
