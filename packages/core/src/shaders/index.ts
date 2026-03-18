// @ts-ignore - handled by tsup's .wgsl text loader
import gnosisCreate2Shader from './gnosis-create2.wgsl';
// @ts-ignore
import keccakBenchShader from './keccak.wgsl';
// @ts-ignore
import keyminerShader from './keyminer.wgsl';
// @ts-ignore
import verificationShader from './verification.wgsl';

// Modular shader components
// @ts-ignore
import keccak256Wgsl from './wgsl/keccak256.wgsl';
// @ts-ignore
import secp256k1FieldWgsl from './wgsl/secp256k1-field.wgsl';
// @ts-ignore
import secp256k1EcWgsl from './wgsl/secp256k1-ec.wgsl';

export {
  gnosisCreate2Shader,
  keccakBenchShader,
  keyminerShader,
  verificationShader,
  keccak256Wgsl,
  secp256k1FieldWgsl,
  secp256k1EcWgsl,
};

/**
 * Assemble the keyminer shader from its modular WGSL components.
 * This concatenates the field, keccak, EC, and dispatch modules.
 */
export function assembleKeyminerShader(parts: {
  field: string;
  keccak: string;
  ec: string;
  dispatch: string;
}): string {
  return [parts.field, parts.keccak, parts.ec, parts.dispatch].join('\n');
}
