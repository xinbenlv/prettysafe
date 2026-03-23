# @prettysafe/core

Core library for [PrettySafe](https://prettysafe.xyz) — the browser-native WebGPU vanity address miner for [Safe](https://safe.global) (formerly Gnosis Safe) wallets.

## Features

- **WebGPU CREATE2 Mining** — GPU-accelerated vanity address mining at 100–500 MH/s
- **Safe Address Derivation** — encode Safe setup parameters, compute CREATE2 salts, and derive deterministic addresses
- **Multi-Chain Support** — Ethereum, Base, Arbitrum, Optimism, Polygon, Gnosis, and testnets
- **WGSL Shaders** — Keccak-256 and secp256k1 implementations that run entirely on the GPU

## Install

```bash
npm install @prettysafe/core
# or
bun add @prettysafe/core
```

## Usage

### Derive a Safe address

```ts
import {
  encodeSafeSetup,
  computeGnosisSalt,
  computeCreate2Address,
  PROXY_FACTORY,
  PROXY_CREATION_CODE_HASH,
} from '@prettysafe/core';

const setupData = encodeSafeSetup({
  owners: ['0xYourAddress...'],
  threshold: 1,
});

const salt = computeGnosisSalt(setupData, 42n);

const address = computeCreate2Address(
  PROXY_FACTORY,
  salt,
  PROXY_CREATION_CODE_HASH
);
```

### Use the WebGPU miner engine

```ts
import { Create2MinerEngine } from '@prettysafe/core';

const engine = new Create2MinerEngine({
  // miner configuration
});
```

### Access WGSL shaders

```ts
import '@prettysafe/core/shaders';
```

Raw `.wgsl` shader files are also included in the package under `src/shaders/`.

## API

### Safe Encoding

| Export | Description |
|--------|-------------|
| `encodeSafeSetup(config)` | Encode Safe initializer calldata from owners + threshold |
| `computeGnosisSalt(setupData, nonce)` | Compute the Gnosis-style salt from setup data and a nonce |
| `computeCreate2Address(deployer, salt, initCodeHash)` | Derive a CREATE2 address |
| `deriveSafeAddress(config, nonce)` | All-in-one: config + nonce to final address |
| `prepareShaderData(config)` | Prepare data buffers for the GPU shader |

### Address Utilities

| Export | Description |
|--------|-------------|
| `countLeadingZeros(address)` | Count leading zero nibbles in an address |
| `isAddressSmaller(a, b)` | Compare two addresses numerically |
| `addressToBigInt(address)` | Convert an address to a BigInt |

### Network Configuration

| Export | Description |
|--------|-------------|
| `SUPPORTED_NETWORKS` | Array of enabled network configs |
| `COMING_SOON_NETWORKS` | Networks not yet enabled |
| `getNetworkConfig(chainId)` | Look up config by chain ID |
| `isSupportedNetwork(chainId)` | Check if a chain ID is supported |

### Constants

| Export | Description |
|--------|-------------|
| `PROXY_FACTORY` | Safe Proxy Factory address (`0xa6B71E26...`) |
| `SAFE_SINGLETON` | Safe singleton address |
| `PROXY_CREATION_CODE_HASH` | Proxy creation code hash for CREATE2 |
| `DEFAULT_FALLBACK_HANDLER` | Default fallback handler address |
| `PROXY_FACTORY_ABI` | ABI for the Proxy Factory contract |
| `SAFE_ABI` / `SAFE_READONLY_ABI` | ABIs for Safe contract interactions |

### Mining Engine

| Export | Description |
|--------|-------------|
| `Create2MinerEngine` | WebGPU-powered CREATE2 salt miner |
| `MinerConfig` | Configuration type for the engine |
| `MinerCallbacks` | Callback hooks (on match, on progress, etc.) |
| `MinerState` | Current state of the miner |

### Types

| Export | Description |
|--------|-------------|
| `SafeConfig` | `{ owners: string[], threshold: number }` |
| `NetworkConfig` | Chain configuration (name, RPC, explorer, etc.) |

## How It Works

PrettySafe mines CREATE2 salt values to find vanity addresses for Safe wallets:

```
address = keccak256(0xff ++ deployer ++ salt ++ initCodeHash)[12:]
```

The salt incorporates the Safe setup parameters (owners, threshold) via a two-step Gnosis derivation, then the GPU brute-forces nonce values at massive parallelism (65,535 x 16 workgroups x 64 threads = ~67M parallel hashes per dispatch).

## Requirements

- WebGPU-capable environment (modern browsers, or Node/Bun with `bun-webgpu`)
- [viem](https://viem.sh) ^2.21.0 (peer-ish dependency, included)

## License

MIT
