# @ercref/erc8117

TypeScript implementation of [ERC-8117](https://eips.ethereum.org/EIPS/eip-8117) — a compressed display format for Ethereum addresses with leading zeros.

## What is ERC-8117?

Ethereum vanity addresses with many leading zeros (e.g. `0x00000000219ab540356cBB839Cbe05303d7705Fa`) are hard to read. ERC-8117 defines a compact notation that replaces consecutive leading zero nibbles with a subscript count:

| Full Address | ERC-8117 (Unicode) | ERC-8117 (ASCII) |
|---|---|---|
| `0x00000000219ab540...` | `0x0₈219ab540...` | `0x0(8)219ab540...` |
| `0x0000000071727De2...` | `0x0₇71727De2...` | `0x0(7)71727De2...` |

Compression only triggers when there are **4 or more** consecutive leading zero nibbles after the `0x` prefix.

## Install

```bash
npm install @ercref/erc8117
# or
bun add @ercref/erc8117
```

## Usage

```ts
import { compressAddressERC8117 } from '@ercref/erc8117';

// Unicode mode (default) — uses subscript digits
compressAddressERC8117('0x00000000219ab540356cBB839Cbe05303d7705Fa');
// → '0x0₈219ab540356cBB839Cbe05303d7705Fa'

// ASCII mode — uses parentheses
compressAddressERC8117('0x00000000219ab540356cBB839Cbe05303d7705Fa', 'ascii');
// → '0x0(8)219ab540356cBB839Cbe05303d7705Fa'

// Truncated display
compressAddressERC8117('0x00000000219ab540356cBB839Cbe05303d7705Fa', 'unicode', true);
// → '0x0₈219a...05Fa'
```

### Helper utilities

```ts
import { toSubscript, SUBSCRIPTS } from '@ercref/erc8117';

toSubscript(42);  // → '₄₂'
SUBSCRIPTS['7'];  // → '₇'
```

## API

### `compressAddressERC8117(address, mode?, truncate?)`

Compress an Ethereum address using ERC-8117 notation.

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `address` | `string` | — | Ethereum address (with or without `0x` prefix) |
| `mode` | `'unicode' \| 'ascii'` | `'unicode'` | `'unicode'` uses subscript digits (`0₇`), `'ascii'` uses parentheses (`0(7)`) |
| `truncate` | `boolean` | `false` | Truncate the suffix with ellipsis for compact display |

Returns the compressed address string.

### `toSubscript(num)`

Convert a number to its Unicode subscript representation.

### `SUBSCRIPTS`

Record mapping digit characters (`'0'`–`'9'`) to their Unicode subscript equivalents (`'₀'`–`'₉'`).

## License

MIT
