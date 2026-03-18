export type Create2Testcase = {
  name: string;
  expectedAddress: string;
  txHash: string;
  deployer: string; // address executing CREATE2
  salt: string; // 0x + 32 bytes
  initCodeHash: string; // 0x + 32 bytes
  note?: string;
};

// Extracted from Etherscan mainnet:
// - module=contract&action=getcontractcreation (creator/factory/txHash)
// - module=proxy&action=eth_getTransactionByHash + ABI decode when needed
//
// No API key stored here.
export const MAINNET_CREATE2_TESTCASES: Create2Testcase[] = [
  {
    name: "Namefi: NFNFT Token",
    expectedAddress: "0x0000000000cf80E7Cf8Fa4480907f692177f8e06",
    txHash: "0x3f62692e8c0f6940280925c9982572110bd0dfc893a5d03284c9ad3548b7b83a",
    deployer: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    salt: "0x0000000000000000000000000000000000000000ebf9c231fad1d33999ec0da2",
    initCodeHash: "0xe257f5b9a7a384bf94859ce765b5072cc9a1bf608df090b6e1f0e16eb04439ee",
    note: "EIP-2470 deterministic deployer raw calldata (salt||initCode).",
  },
  {
    name: "Uniswap Permit2",
    expectedAddress: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    txHash: "0xf2f1fe96c16ee674bb7fcee166be52465a418927d124f5f1d231b36eae65d377",
    deployer: "0x4e59b44847b379578588920ca78fbf26c0b4956c",
    salt: "0x0000000000000000000000000000000000000000d3af2663da51c10215000000",
    initCodeHash: "0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8",
    note: "EIP-2470 deterministic deployer raw calldata (salt||initCode).",
  },
  {
    name: "OpenSea Seaport 1.4",
    expectedAddress: "0x00000000000000adc04c56bf30ac9d3c0aaf14dc",
    txHash: "0xa7f75a8b23c0f3150b7116aae930101f42996cb35e3e596a646156926350933a",
    deployer: "0x0000000000ffe8b47b3e2130213b802212439497",
    salt: "0x0000000000000000000000000000000000000000d4b6fcc21169b803f25d2210",
    initCodeHash: "0x1ef74b01ea316aa17dc8c7c60387f422c5a73cd5f6cac866d831b40740531144",
    note: "Factory call safeCreate2(bytes32 salt, bytes initCode).",
  },
  {
    name: "OpenSea Seaport 1.5",
    expectedAddress: "0x0000000000000068f116a894984e2db1123eb395",
    txHash: "0x926e958d5919f0089f47a353b0a8a211bd858abb20348261d41672d77fa7c6a0",
    deployer: "0x0000000000ffe8b47b3e2130213b802212439497",
    salt: "0x0000000000000000000000000000000000000000d738b7f0bb99901b1c83f249",
    initCodeHash: "0xde057106c8377de87f4547af6ef65fa2c96fddbc136be5748060ed7c32902d94",
    note: "Factory call safeCreate2(bytes32 salt, bytes initCode).",
  },
  {
    name: "Uniswap v4 PoolManager",
    expectedAddress: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    txHash: "0x747e0e02b7590eed32cface28e83260884e0b80675f5ae223c6888053aa68528",
    deployer: "0x48e516b34a1274f49457b9c6182097796d0498cb",
    salt: "0x72bed203c9a5eff37e1f55be91f742def6e0e5c7bd40398de517b6047b87ee78",
    initCodeHash: "0x94d114296a5af85c1fd2dc039cdaa32f1ed4b0fe0868f02d888bfc91feb645d9",
    note: "Factory call deploy(bytes initCode); CREATE2 executed by the factory itself using bestAddressSalt().",
  },
];

