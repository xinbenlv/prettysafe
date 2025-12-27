# WebGPU Create2 Cruncher (Created by gemini-3-pro-preview)

This project implements an Ethereum **Create2** address mining kernel using **WebGPU**. It is a port of the OpenCL kernel from `create2crunch` to WGSL.

## Features

- **Cross-Platform**: Runs in browsers (Chrome, Edge, etc.) and headless environments (Bun/Node).
- **High Performance**: Uses WebGPU Compute Shaders.
- **64-bit Emulation**: Implements 64-bit integer arithmetic (XOR, ROT, AND, NOT) in WGSL using `vec2<u32>` since native `u64` is not yet widely supported in WebGPU.

## Prerequisites

- [Bun](https://bun.sh) (for CLI tools and package management).
- A **WebGPU-compatible Browser** (Chrome 113+, Edge 113+) OR a system with drivers supporting Vulkan/Metal/DirectX12 for headless mode.

## Installation

```bash
cd src-webgpu
bun install
```

## Usage

### 1. Headless Benchmark (CLI)

Runs the kernel in a headless environment (using `bun-webgpu`) to measure raw hashrate.

```bash
# Run for 5 seconds (default)
bun run benchmark

# Run for 10 seconds
bun run benchmark --sec 10

# Run until 100 Million hashes
bun run benchmark --hash 100000000
```

### 2. Validation Test

Runs a single-shot test case against a known Ethereum Mainnet deployment to verify the hashing logic matches `ethers.js`.

```bash
bun run test
```

Expected Output:
```
✅ All Tests Passed!
```

### 3. Browser Benchmark (GUI)

Launches a local web server. Open the link in a browser to run the benchmark on your GPU via the browser's WebGPU implementation.

```bash
bun start
```
Visit `http://localhost:5173`.

## Architecture

### Kernel (`keccak.wgsl`)
- **Input**: A "Template State" (200 bytes) representing the pre-calculated Keccak state of `0xff ++ Factory ++ SaltPrefix`.
- **Nonce Injection**: The kernel injects a 64-bit nonce into the state at specific byte offsets (bytes 45-52) corresponding to the salt's variable part.
- **Keccak-f[1600]**: Runs the full 24-round permutation.
- **Output**: Checks if the resulting hash meets a threshold (e.g., leading zeros). For benchmarking, it calculates the hash unconditionally.

### 64-bit Emulation
WebGPU (WGSL) does not guaranteed support for `u64`. We emulate it using `vec2<u32>` (Low, High words).
- `xor_u64`: Component-wise XOR.
- `rol_u64`: Bitwise rotation handling carry-over between words.

### Verification
The logic was validated against the deployment of `0x0000000000cf80E7Cf8Fa4480907f692177f8e06` on Ethereum Mainnet. The WebGPU kernel produces the exact same Keccak-256 hash as `ethers.getCreate2Address`.
