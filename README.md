# WebGPU Create2 Cruncher

A high-performance Ethereum **CREATE2** address mining tool using **WebGPU**. Ported from the OpenCL kernel of `create2crunch` to WGSL.

## Features

- **Cross-Platform**: Runs in browsers (Chrome, Edge, etc.) and headless environments (Bun).
- **High Performance**: Uses WebGPU Compute Shaders with 2D dispatch for optimal GPU utilization.
- **64-bit Emulation**: Implements 64-bit integer arithmetic in WGSL using `vec2<u32>`.

## Prerequisites

- [Bun](https://bun.sh) for CLI tools and package management.
- A WebGPU-compatible system (Vulkan/Metal/DirectX12) or browser (Chrome 113+, Edge 113+).

## Installation

```bash
bun install
```

## Usage

### 1. Benchmark (CLI)

```bash
# Run for 5 seconds (default)
bun run benchmark

# Run for custom duration
bun run benchmark --sec 10

# Run until specific hash count
bun run benchmark --hash 100000000
```

### 2. Tests

Validates the Keccak-256 implementation against known Ethereum mainnet CREATE2 deployments.

```bash
bun run test
```

### 3. Browser Benchmark

```bash
bun start
```
Visit `http://localhost:5173`.

## Project Structure

```
├── benchmark.ts       # CLI benchmark runner
├── test.ts           # Test suite for CREATE2 verification
├── test-data.ts      # Mainnet test cases (Uniswap, OpenSea, etc.)
├── keccak.wgsl       # Main Keccak-256 compute shader (2D dispatch)
├── verification.wgsl # Shader for test verification
├── main.ts           # Browser benchmark UI
└── index.html        # Web interface
```

## Architecture

### Keccak Shader (`keccak.wgsl`)
- **Input**: Template state (200 bytes) with pre-calculated `0xff ++ Factory ++ SaltPrefix`.
- **Nonce Injection**: 64-bit nonce injected at bytes 45-52.
- **Keccak-f[1600]**: Full 24-round permutation.
- **2D Dispatch**: 65535 × 16 workgroups for maximum parallelism.

### 64-bit Emulation
WGSL lacks native `u64`, so we use `vec2<u32>` (low, high) with custom operations:
- `xor_u64`: Component-wise XOR
- `rol_lo/rol_hi`: Rotation handling cross-word carry

### Validation
Verified against real mainnet deployments including Uniswap Permit2, OpenSea Seaport, and Uniswap v4 PoolManager.
