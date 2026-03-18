export declare const gnosisCreate2Shader: string;
export declare const keccakBenchShader: string;
export declare const keyminerShader: string;
export declare const verificationShader: string;
export declare const keccak256Wgsl: string;
export declare const secp256k1FieldWgsl: string;
export declare const secp256k1EcWgsl: string;
export declare function assembleKeyminerShader(parts: {
  field: string;
  keccak: string;
  ec: string;
  dispatch: string;
}): string;
