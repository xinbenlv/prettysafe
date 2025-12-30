# WebGPU Create2 Cruncher

A high-performance Ethereum **CREATE2** address mining tool using **WebGPU**. Ported from the OpenCL kernel of `create2crunch` to WGSL.

## 🎯 What It Does

This tool helps you find **vanity Ethereum addresses** by mining CREATE2 salt values. CREATE2 is an Ethereum opcode that allows deterministic contract address generation based on:

- **Deployer address** (factory contract)
- **Salt** (32-byte value)
- **Init code hash** (hash of contract bytecode)

```
address = keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]
```

### Key Features

| Feature | Description |
|---------|-------------|
| 🖥️ **Safe Vanity Miner** | Mine vanity addresses for Gnosis Safe contracts |
| 📊 **Benchmark Mode** | Compare WebGPU vs CPU (ethers.js, viem) performance |
| 🌐 **Cross-Platform** | Runs in browsers (Chrome, Edge) and CLI (Bun) |
| ⚡ **GPU Accelerated** | Uses WebGPU Compute Shaders for massive parallelism |
| 🔬 **Verified** | Tested against real mainnet deployments (Uniswap, OpenSea) |

---

## 🏗️ Architecture

### High-Level System Overview

```mermaid
flowchart TB
    subgraph Frontend["🌐 Web Frontend (React + Vite)"]
        UI[Web UI]
        Miner[Safe Vanity Miner]
        Bench[Benchmark Panel]
    end

    subgraph Backend["⚙️ Compute Layer"]
        WebGPU[WebGPU API]
        BunGPU[bun-webgpu]
    end

    subgraph Shaders["🔧 WGSL Shaders"]
        GnosisSafe[gnosis-create2.wgsl]
        Keccak[keccak.wgsl]
        Verify[verification.wgsl]
    end

    subgraph GPU["🎮 GPU Hardware"]
        Compute[Compute Units]
    end

    UI --> Miner
    UI --> Bench
    Miner --> WebGPU
    Bench --> WebGPU
    Bench --> BunGPU
    WebGPU --> GnosisSafe
    WebGPU --> Keccak
    BunGPU --> Keccak
    BunGPU --> Verify
    GnosisSafe --> Compute
    Keccak --> Compute
    Verify --> Compute
```

### Create2 Address Derivation Flow

```mermaid
sequenceDiagram
    participant User
    participant App as Web App
    participant GPU as WebGPU
    participant Shader as WGSL Shader

    User->>App: Configure Safe (owners, threshold)
    App->>App: Encode initializer data
    App->>App: Hash initializer → initializerHash
    App->>GPU: Upload constants (factory, initializerHash, proxyCodeHash)

    loop Mining Loop
        App->>GPU: Dispatch workgroups (65535 × 16)
        GPU->>Shader: Execute 67M+ parallel threads

        par For each nonce in parallel
            Shader->>Shader: gnosisSalt = keccak256(initializerHash ++ nonce)
            Shader->>Shader: address = keccak256(0xff ++ factory ++ gnosisSalt ++ proxyCodeHash)[12:]
            Shader->>Shader: Compare with best address (atomic)
        end

        GPU->>App: Return best nonce found
        App->>User: Display progress & best address
    end
```

### Gnosis Safe Address Derivation (Two-Step Keccak)

```mermaid
flowchart LR
    subgraph Step1["Step 1: Compute gnosisSalt"]
        IH[initializerHash<br/>32 bytes] --> K1
        Nonce[saltNonce<br/>32 bytes] --> K1
        K1[keccak256] --> Salt[gnosisSalt<br/>32 bytes]
    end

    subgraph Step2["Step 2: Compute Address"]
        Prefix[0xff<br/>1 byte] --> K2
        Factory[factory<br/>20 bytes] --> K2
        Salt --> K2
        PCH[proxyCodeHash<br/>32 bytes] --> K2
        K2[keccak256] --> Hash[Hash<br/>32 bytes]
        Hash --> Extract[Extract bytes 12-31]
        Extract --> Addr[Address<br/>20 bytes]
    end
```

### GPU Dispatch Architecture

```mermaid
flowchart TB
    subgraph Dispatch["2D Dispatch Grid"]
        direction TB
        X["X: 65,535 workgroups"]
        Y["Y: 16 workgroups"]
    end

    subgraph Workgroup["Each Workgroup"]
        Threads["64 threads"]
    end

    subgraph Total["Total Parallelism"]
        Calc["65,535 × 16 × 64 = 67,107,840 hashes/dispatch"]
    end

    Dispatch --> Workgroup
    Workgroup --> Total
```

### Keccak-256 Implementation Details

```mermaid
flowchart TB
    subgraph Input["Input Preparation"]
        Template[Template State<br/>200 bytes]
        Nonce64[64-bit Nonce<br/>Injected at bytes 45-52]
    end

    subgraph Keccak["Keccak-f[1600] Permutation"]
        direction TB
        Rounds["24 Rounds"]

        subgraph Round["Each Round"]
            Theta["θ (Theta)"]
            RhoPi["ρπ (Rho-Pi)"]
            Chi["χ (Chi)"]
            Iota["ι (Iota)"]
        end
    end

    subgraph U64Emulation["64-bit Emulation (WGSL lacks u64)"]
        Vec2["vec2<u32> = (low, high)"]
        XOR["xor_u64: Component XOR"]
        ROL["rol_lo/rol_hi: Rotation with carry"]
    end

    Input --> Keccak
    Keccak --> Output[32-byte Hash]
    U64Emulation -.-> Round
    Theta --> RhoPi --> Chi --> Iota
```

---

## 🚀 Getting Started

### Prerequisites

- [Bun](https://bun.sh) for CLI tools and package management
- A WebGPU-compatible system:
  - **GPU**: Vulkan, Metal, or DirectX12 support
  - **Browser**: Chrome 113+, Edge 113+, or Firefox Nightly

### Installation

```bash
bun install
```

---

## 📖 Usage

### 1. Web Application (Safe Vanity Miner)

Start the development server:

```bash
bun dev
```

Visit `http://localhost:5173` in your browser.

**Features:**
- **Safe Miner Mode**: Configure Gnosis Safe parameters (owners, threshold) and mine vanity addresses
- **Benchmark Mode**: Compare GPU vs CPU hashing performance

```mermaid
flowchart LR
    subgraph Modes["App Modes"]
        Miner["🔨 Safe Miner<br/>Mine vanity addresses"]
        Benchmark["📊 Benchmark<br/>Compare GPU vs CPU"]
    end

    Miner --> Config["Configure Safe"]
    Config --> Mine["Start Mining"]
    Mine --> Result["Best Address Found"]

    Benchmark --> Run["Run Tests"]
    Run --> Chart["Performance Chart"]
```

### 2. CLI Benchmark

Run pure Keccak-256 throughput benchmark:

```bash
# Run for 5 seconds (default)
bun run benchmark

# Run for custom duration
bun run benchmark --sec 10

# Run until specific hash count
bun run benchmark --hash 100000000
```

**Example Output:**
```
🚀 Initializing WebGPU Keccak256 Benchmark...
⏱️  Target: 5 seconds
💻 Using GPU: Apple M1 Pro
Running... 5000ms | 1234.56 MHashes

📊 Results:
   Duration: 5.0012s
   Total Hashes: 1,234,567,890
   Hashrate: 246.87 MH/s
```

### 3. Tests

Validate the Keccak-256 implementation against known Ethereum mainnet CREATE2 deployments:

```bash
bun run test
```

**Test Cases Include:**
- Uniswap Permit2
- OpenSea Seaport
- Uniswap v4 PoolManager

```bash
# Test Safe address derivation specifically
bun run test:derivation
```

---

## 📁 Project Structure

```
.
├── 🌐 Web Application
│   ├── index.html              # Entry point
│   ├── src/
│   │   ├── App.tsx             # Main React app (mode switcher)
│   │   ├── components/
│   │   │   ├── SafeMinerPanel.tsx   # Vanity miner UI
│   │   │   ├── BenchmarkPanel.tsx   # Benchmark UI
│   │   │   └── HashRateChart.tsx    # D3 chart
│   │   ├── hooks/
│   │   │   ├── useSafeMiner.ts      # Mining logic
│   │   │   └── useWebGPUBenchmark.ts
│   │   └── lib/
│   │       ├── safe-encoder.ts      # Safe config encoding
│   │       └── gnosis-constants.ts  # Factory addresses
│
├── ⚙️ WGSL Shaders
│   ├── gnosis-create2.wgsl     # Gnosis Safe address mining
│   ├── keccak.wgsl             # Generic Keccak-256 benchmark
│   └── verification.wgsl       # Test verification shader
│
├── 🔧 CLI Tools
│   ├── benchmark.ts            # CLI benchmark runner
│   └── test.ts                 # Test suite
│
└── 📋 Configuration
    ├── package.json
    ├── vite.config.ts
    ├── tailwind.config.js
    └── tsconfig.json
```

---

## ⚡ Performance

### GPU vs CPU Comparison

| Implementation | Typical Hashrate | Relative Speed |
|---------------|------------------|----------------|
| **WebGPU (GPU)** | 100-500 MH/s | 🚀 1,000,000x |
| ethers.js (CPU) | 50-200 H/s | 1x |
| viem (CPU) | 50-200 H/s | 1x |

*Performance varies by hardware. Apple M-series and modern NVIDIA/AMD GPUs achieve the highest rates.*

### Optimization Techniques

1. **2D Dispatch**: 65,535 × 16 workgroups maximize GPU occupancy
2. **64-bit Emulation**: Custom `vec2<u32>` operations for Keccak rotations
3. **Atomic Operations**: Lock-free best-address tracking
4. **Pre-computed State**: Template with factory and initCodeHash pre-loaded

---

## 🔒 How Gnosis Safe Mining Works

```mermaid
flowchart TB
    subgraph Config["User Configuration"]
        Owners["Owners[]"]
        Threshold["Threshold"]
    end

    subgraph Encoding["1. Encode Initializer"]
        Setup["setup(owners, threshold, ...)"]
        InitData["initializer bytes"]
    end

    subgraph Hashing["2. Compute Hashes"]
        InitHash["initializerHash = keccak256(initializer)"]
    end

    subgraph Mining["3. GPU Mining Loop"]
        Nonce["Try nonce: 0, 1, 2, ..."]
        GnosisSalt["gnosisSalt = keccak256(initializerHash ++ nonce)"]
        Address["address = CREATE2(factory, gnosisSalt, proxyCodeHash)"]
        Compare["Is address < best?"]
        Update["Update best"]
    end

    Config --> Encoding --> Hashing --> Mining
    Compare -->|Yes| Update
    Compare -->|No| Nonce
    Update --> Nonce
```

The miner finds the **numerically smallest** address by incrementing the salt nonce. Lower addresses (more leading zeros) are generally considered more desirable "vanity" addresses.

---

## 🧪 Validation

The keccak-256 WGSL implementation is verified against real Ethereum mainnet deployments:

| Protocol | Contract | Status |
|----------|----------|--------|
| Uniswap | Permit2 | ✅ Verified |
| OpenSea | Seaport | ✅ Verified |
| Uniswap | v4 PoolManager | ✅ Verified |
| Namefi | Namefi NFT | ✅ Verified |
