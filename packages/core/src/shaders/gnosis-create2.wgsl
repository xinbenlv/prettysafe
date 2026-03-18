// WebGPU Compute Shader for Gnosis Safe Create2 Vanity Address Mining
// Finds numerically smallest addresses by incrementing saltNonce

alias u64 = vec2<u32>;

fn make_u64(low: u32, high: u32) -> u64 { return vec2<u32>(low, high); }
fn xor_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x ^ b.x, a.y ^ b.y); }
fn and_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x & b.x, a.y & b.y); }
fn not_u64(a: u64) -> u64 { return vec2<u32>(~a.x, ~a.y); }

fn rol_lo(x: u64, n: u32) -> u64 {
    return vec2<u32>((x.x << n) | (x.y >> (32u - n)), (x.y << n) | (x.x >> (32u - n)));
}

fn rol_hi(x: u64, n: u32) -> u64 {
    let shift = n - 32u;
    return vec2<u32>((x.y << shift) | (x.x >> (32u - shift)), (x.x << shift) | (x.y >> (32u - shift)));
}

// Constants buffer: initializerHash (32) + factory (20) + proxyCodeHash (32) = 84 bytes, padded to 96
struct Constants {
    initializer_hash: array<u32, 8>,   // 32 bytes
    factory: array<u32, 5>,            // 20 bytes
    proxy_code_hash: array<u32, 8>,    // 32 bytes
    padding: u32,                       // alignment padding
}

struct Params {
    nonce_offset: u32,
    iteration: u32,
    padding1: u32,
    padding2: u32,
}

// Best result: nonce (8 bytes) + address (20 bytes) + found flag
struct BestResult {
    nonce_low: atomic<u32>,
    nonce_high: atomic<u32>,
    // Store address as 5 u32s (20 bytes) for atomic comparison
    addr0: atomic<u32>,
    addr1: atomic<u32>,
    addr2: atomic<u32>,
    addr3: atomic<u32>,
    addr4: atomic<u32>,
    found: atomic<u32>,
}

@group(0) @binding(0) var<storage, read> constants: Constants;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> best: BestResult;

fn theta(a: ptr<function, array<u64, 25>>) {
    var b: array<u64, 5>;
    var t: u64;
    b[0] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[0], (*a)[5]), (*a)[10]), (*a)[15]), (*a)[20]);
    b[1] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[1], (*a)[6]), (*a)[11]), (*a)[16]), (*a)[21]);
    b[2] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[2], (*a)[7]), (*a)[12]), (*a)[17]), (*a)[22]);
    b[3] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[3], (*a)[8]), (*a)[13]), (*a)[18]), (*a)[23]);
    b[4] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[4], (*a)[9]), (*a)[14]), (*a)[19]), (*a)[24]);

    t = xor_u64(b[4], rol_lo(b[1], 1u)); (*a)[0] = xor_u64((*a)[0], t); (*a)[5] = xor_u64((*a)[5], t); (*a)[10] = xor_u64((*a)[10], t); (*a)[15] = xor_u64((*a)[15], t); (*a)[20] = xor_u64((*a)[20], t);
    t = xor_u64(b[0], rol_lo(b[2], 1u)); (*a)[1] = xor_u64((*a)[1], t); (*a)[6] = xor_u64((*a)[6], t); (*a)[11] = xor_u64((*a)[11], t); (*a)[16] = xor_u64((*a)[16], t); (*a)[21] = xor_u64((*a)[21], t);
    t = xor_u64(b[1], rol_lo(b[3], 1u)); (*a)[2] = xor_u64((*a)[2], t); (*a)[7] = xor_u64((*a)[7], t); (*a)[12] = xor_u64((*a)[12], t); (*a)[17] = xor_u64((*a)[17], t); (*a)[22] = xor_u64((*a)[22], t);
    t = xor_u64(b[2], rol_lo(b[4], 1u)); (*a)[3] = xor_u64((*a)[3], t); (*a)[8] = xor_u64((*a)[8], t); (*a)[13] = xor_u64((*a)[13], t); (*a)[18] = xor_u64((*a)[18], t); (*a)[23] = xor_u64((*a)[23], t);
    t = xor_u64(b[3], rol_lo(b[0], 1u)); (*a)[4] = xor_u64((*a)[4], t); (*a)[9] = xor_u64((*a)[9], t); (*a)[14] = xor_u64((*a)[14], t); (*a)[19] = xor_u64((*a)[19], t); (*a)[24] = xor_u64((*a)[24], t);
}

fn rhoPi(a: ptr<function, array<u64, 25>>) {
    var t: u64; var b0: u64;
    t = (*a)[1]; b0 = (*a)[10]; (*a)[10] = rol_lo(t, 1u);
    t = b0; b0 = (*a)[7]; (*a)[7] = rol_lo(t, 3u);
    t = b0; b0 = (*a)[11]; (*a)[11] = rol_lo(t, 6u);
    t = b0; b0 = (*a)[17]; (*a)[17] = rol_lo(t, 10u);
    t = b0; b0 = (*a)[18]; (*a)[18] = rol_lo(t, 15u);
    t = b0; b0 = (*a)[3]; (*a)[3] = rol_lo(t, 21u);
    t = b0; b0 = (*a)[5]; (*a)[5] = rol_lo(t, 28u);
    t = b0; b0 = (*a)[16]; (*a)[16] = rol_hi(t, 36u);
    t = b0; b0 = (*a)[8]; (*a)[8] = rol_hi(t, 45u);
    t = b0; b0 = (*a)[21]; (*a)[21] = rol_hi(t, 55u);
    t = b0; b0 = (*a)[24]; (*a)[24] = rol_lo(t, 2u);
    t = b0; b0 = (*a)[4]; (*a)[4] = rol_lo(t, 14u);
    t = b0; b0 = (*a)[15]; (*a)[15] = rol_lo(t, 27u);
    t = b0; b0 = (*a)[23]; (*a)[23] = rol_hi(t, 41u);
    t = b0; b0 = (*a)[19]; (*a)[19] = rol_hi(t, 56u);
    t = b0; b0 = (*a)[13]; (*a)[13] = rol_lo(t, 8u);
    t = b0; b0 = (*a)[12]; (*a)[12] = rol_lo(t, 25u);
    t = b0; b0 = (*a)[2]; (*a)[2] = rol_hi(t, 43u);
    t = b0; b0 = (*a)[20]; (*a)[20] = rol_hi(t, 62u);
    t = b0; b0 = (*a)[14]; (*a)[14] = rol_lo(t, 18u);
    t = b0; b0 = (*a)[22]; (*a)[22] = rol_hi(t, 39u);
    t = b0; b0 = (*a)[9]; (*a)[9] = rol_hi(t, 61u);
    t = b0; b0 = (*a)[6]; (*a)[6] = rol_lo(t, 20u);
    t = b0; b0 = (*a)[1]; (*a)[1] = rol_hi(t, 44u);
}

fn chi(a: ptr<function, array<u64, 25>>) {
    var b: array<u64, 5>;

    b[0] = (*a)[0]; b[1] = (*a)[1]; b[2] = (*a)[2]; b[3] = (*a)[3]; b[4] = (*a)[4];
    (*a)[0] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[1] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[2] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[3] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[4] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    b[0] = (*a)[5]; b[1] = (*a)[6]; b[2] = (*a)[7]; b[3] = (*a)[8]; b[4] = (*a)[9];
    (*a)[5] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[6] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[7] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[8] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[9] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    b[0] = (*a)[10]; b[1] = (*a)[11]; b[2] = (*a)[12]; b[3] = (*a)[13]; b[4] = (*a)[14];
    (*a)[10] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[11] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[12] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[13] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[14] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    b[0] = (*a)[15]; b[1] = (*a)[16]; b[2] = (*a)[17]; b[3] = (*a)[18]; b[4] = (*a)[19];
    (*a)[15] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[16] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[17] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[18] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[19] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    b[0] = (*a)[20]; b[1] = (*a)[21]; b[2] = (*a)[22]; b[3] = (*a)[23]; b[4] = (*a)[24];
    (*a)[20] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[21] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[22] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[23] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[24] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));
}

fn iota(a: ptr<function, array<u64, 25>>, roundConst: u64) { (*a)[0] = xor_u64((*a)[0], roundConst); }

fn keccakf(a: ptr<function, array<u64, 25>>) {
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00000001u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008082u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x0000808au, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80008000u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x0000808bu, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80000001u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80008081u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008009u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x0000008au, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00000088u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80008009u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x8000000au, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x8000808bu, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x0000008bu, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008089u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008003u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008002u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00000080u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x0000800au, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x8000000au, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80008081u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x00008080u, 0x80000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80000001u, 0x00000000u));
    theta(a); rhoPi(a); chi(a); iota(a, make_u64(0x80008008u, 0x80000000u));
}

// Swap endianness of a u32 (for big-endian address comparison)
fn swap_endian(x: u32) -> u32 {
    return ((x & 0xFFu) << 24u) |
           ((x & 0xFF00u) << 8u) |
           ((x & 0xFF0000u) >> 8u) |
           ((x & 0xFF000000u) >> 24u);
}

// Keccak256 for 64-byte input (initializerHash + saltNonce)
// Returns the hash as 8 u32s
fn keccak256_64(input: array<u32, 16>) -> array<u32, 8> {
    var state: array<u64, 25>;

    // Initialize state to zero
    for (var i = 0u; i < 25u; i++) {
        state[i] = make_u64(0u, 0u);
    }

    // Absorb 64 bytes (8 u64s) - little endian
    for (var i = 0u; i < 8u; i++) {
        state[i] = make_u64(input[i * 2u], input[i * 2u + 1u]);
    }

    // Padding for 64-byte message: 0x01 at byte 64, 0x80 at byte 135
    // state[8] gets 0x01 in its low byte
    state[8] = xor_u64(state[8], make_u64(0x01u, 0u));
    // state[16] gets 0x80 in its high byte (byte 135 = state[16].high[7])
    state[16] = xor_u64(state[16], make_u64(0u, 0x80000000u));

    keccakf(&state);

    var result: array<u32, 8>;
    for (var i = 0u; i < 4u; i++) {
        result[i * 2u] = state[i].x;
        result[i * 2u + 1u] = state[i].y;
    }
    return result;
}

// Keccak256 for 85-byte input (0xff + factory + salt + codeHash)
// Returns the last 20 bytes as 5 u32s (address)
//
// Input layout (85 bytes):
//   byte 0: 0xff
//   bytes 1-20: factory (20 bytes)
//   bytes 21-52: gnosisSalt (32 bytes)
//   bytes 53-84: proxyCodeHash (32 bytes)
//
// Keccak state mapping (8 bytes per u64):
//   state[0]: bytes 0-7   = 0xff + factory[0..6]
//   state[1]: bytes 8-15  = factory[7..14]
//   state[2]: bytes 16-23 = factory[15..19] + salt[0..2]
//   state[3]: bytes 24-31 = salt[3..10]
//   state[4]: bytes 32-39 = salt[11..18]
//   state[5]: bytes 40-47 = salt[19..26]
//   state[6]: bytes 48-55 = salt[27..31] + codeHash[0..2]
//   state[7]: bytes 56-63 = codeHash[3..10]
//   state[8]: bytes 64-71 = codeHash[11..18]
//   state[9]: bytes 72-79 = codeHash[19..26]
//   state[10]: bytes 80-87 = codeHash[27..31] + padding
fn keccak256_85_address(factory: array<u32, 5>, salt: array<u32, 8>, code_hash: array<u32, 8>) -> array<u32, 5> {
    var state: array<u64, 25>;

    // Initialize state to zero
    for (var i = 0u; i < 25u; i++) {
        state[i] = make_u64(0u, 0u);
    }

    // Helper: extract bytes from u32 (little-endian memory layout)
    // u32 in memory: [byte0, byte1, byte2, byte3] where byte0 = u32 & 0xFF

    // state[0]: bytes 0-7 = 0xff + factory[0..6]
    // byte 0: 0xff
    // bytes 1-4: factory[0] (4 bytes)
    // bytes 5-7: factory[1] low 3 bytes
    let s0_low = 0xFFu | (factory[0] << 8u);
    let s0_high = (factory[0] >> 24u) | (factory[1] << 8u);
    state[0] = make_u64(s0_low, s0_high);

    // state[1]: bytes 8-15 = factory[7..14]
    // bytes 8-11: factory[1] high byte + factory[2] low 3 bytes
    // bytes 12-15: factory[2] high byte + factory[3] low 3 bytes
    let s1_low = (factory[1] >> 24u) | (factory[2] << 8u);
    let s1_high = (factory[2] >> 24u) | (factory[3] << 8u);
    state[1] = make_u64(s1_low, s1_high);

    // state[2]: bytes 16-23 = factory[15..19] + salt[0..2]
    // bytes 16-19: factory[3] high byte + factory[4] low 3 bytes
    // bytes 20: factory[4] high byte (= factory byte 19, the last one)
    // bytes 21-23: salt[0..2] (salt low 3 bytes)
    let s2_low = (factory[3] >> 24u) | (factory[4] << 8u);
    let s2_high = (factory[4] >> 24u) | (salt[0] << 8u);
    state[2] = make_u64(s2_low, s2_high);

    // state[3]: bytes 24-31 = salt[3..10]
    // bytes 24-27: salt[0] high byte + salt[1] low 3 bytes
    // bytes 28-31: salt[1] high byte + salt[2] low 3 bytes
    let s3_low = (salt[0] >> 24u) | (salt[1] << 8u);
    let s3_high = (salt[1] >> 24u) | (salt[2] << 8u);
    state[3] = make_u64(s3_low, s3_high);

    // state[4]: bytes 32-39 = salt[11..18]
    let s4_low = (salt[2] >> 24u) | (salt[3] << 8u);
    let s4_high = (salt[3] >> 24u) | (salt[4] << 8u);
    state[4] = make_u64(s4_low, s4_high);

    // state[5]: bytes 40-47 = salt[19..26]
    let s5_low = (salt[4] >> 24u) | (salt[5] << 8u);
    let s5_high = (salt[5] >> 24u) | (salt[6] << 8u);
    state[5] = make_u64(s5_low, s5_high);

    // state[6]: bytes 48-55 = salt[27..31] + codeHash[0..2]
    // bytes 48-51: salt[6] high byte + salt[7] low 3 bytes
    // bytes 52: salt[7] high byte (= salt byte 31, the last one)
    // bytes 53-55: codeHash[0..2]
    let s6_low = (salt[6] >> 24u) | (salt[7] << 8u);
    let s6_high = (salt[7] >> 24u) | (code_hash[0] << 8u);
    state[6] = make_u64(s6_low, s6_high);

    // state[7]: bytes 56-63 = codeHash[3..10]
    let s7_low = (code_hash[0] >> 24u) | (code_hash[1] << 8u);
    let s7_high = (code_hash[1] >> 24u) | (code_hash[2] << 8u);
    state[7] = make_u64(s7_low, s7_high);

    // state[8]: bytes 64-71 = codeHash[11..18]
    let s8_low = (code_hash[2] >> 24u) | (code_hash[3] << 8u);
    let s8_high = (code_hash[3] >> 24u) | (code_hash[4] << 8u);
    state[8] = make_u64(s8_low, s8_high);

    // state[9]: bytes 72-79 = codeHash[19..26]
    let s9_low = (code_hash[4] >> 24u) | (code_hash[5] << 8u);
    let s9_high = (code_hash[5] >> 24u) | (code_hash[6] << 8u);
    state[9] = make_u64(s9_low, s9_high);

    // state[10]: bytes 80-87 = codeHash[27..31] + padding
    // bytes 80-83: codeHash[6] high byte + codeHash[7] low 3 bytes
    // byte 84: codeHash[7] high byte (= codeHash byte 31, the last one)
    // byte 85: 0x01 (keccak padding start)
    // bytes 86-87: 0x00
    let s10_low = (code_hash[6] >> 24u) | (code_hash[7] << 8u);
    let s10_high = (code_hash[7] >> 24u) | (0x01u << 8u); // padding 0x01 at byte 85
    state[10] = make_u64(s10_low, s10_high);

    // Keccak padding: 0x80 at byte 135 (rate-1 for keccak256 with 136-byte rate)
    // byte 135 = state[16].y bit 24-31
    state[16] = make_u64(0u, 0x80000000u);

    keccakf(&state);

    // Extract last 20 bytes from 32-byte hash
    // Hash is in state[0..3] (32 bytes), address is bytes 12-31
    var result: array<u32, 5>;
    // bytes 12-15: state[1].y
    result[0] = state[1].y;
    // bytes 16-23: state[2]
    result[1] = state[2].x;
    result[2] = state[2].y;
    // bytes 24-31: state[3]
    result[3] = state[3].x;
    result[4] = state[3].y;

    return result;
}

// Compare two addresses (as 5 u32s, big-endian comparison)
// Returns true if new_addr < current_best
fn is_smaller(new_addr: array<u32, 5>, best0: u32, best1: u32, best2: u32, best3: u32, best4: u32) -> bool {
    // Big-endian comparison: compare from most significant byte
    let n0 = swap_endian(new_addr[0]);
    let n1 = swap_endian(new_addr[1]);
    let n2 = swap_endian(new_addr[2]);
    let n3 = swap_endian(new_addr[3]);
    let n4 = swap_endian(new_addr[4]);

    let b0 = swap_endian(best0);
    let b1 = swap_endian(best1);
    let b2 = swap_endian(best2);
    let b3 = swap_endian(best3);
    let b4 = swap_endian(best4);

    if (n0 < b0) { return true; }
    if (n0 > b0) { return false; }
    if (n1 < b1) { return true; }
    if (n1 > b1) { return false; }
    if (n2 < b2) { return true; }
    if (n2 > b2) { return false; }
    if (n3 < b3) { return true; }
    if (n3 > b3) { return false; }
    if (n4 < b4) { return true; }
    return false;
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    // Calculate nonce from thread ID
    // X dimension is 65535 * 64 items = 4194240 per Y slice
    let index = global_id.x + global_id.y * 4194240u;

    let nonce_low = index + params.nonce_offset;
    let nonce_high = params.iteration;

    // Step 1: Compute gnosisSalt = keccak256(initializerHash ++ saltNonce)
    // Input: 32 bytes initializerHash + 32 bytes saltNonce = 64 bytes
    var salt_input: array<u32, 16>;

    // Copy initializerHash (32 bytes = 8 u32s)
    for (var i = 0u; i < 8u; i++) {
        salt_input[i] = constants.initializer_hash[i];
    }

    // Pack saltNonce (as 256-bit big-endian number)
    // For simplicity, we use nonce_low and nonce_high as the nonce
    // Pad to 32 bytes (256 bits)
    // IMPORTANT: Swap endianness to match CPU's big-endian byte order
    salt_input[8] = 0u;
    salt_input[9] = 0u;
    salt_input[10] = 0u;
    salt_input[11] = 0u;
    salt_input[12] = 0u;
    salt_input[13] = 0u;
    salt_input[14] = swap_endian(nonce_high);
    salt_input[15] = swap_endian(nonce_low);

    let gnosis_salt = keccak256_64(salt_input);

    // Step 2: Compute address = keccak256(0xff ++ factory ++ gnosisSalt ++ proxyCodeHash)[12:]
    // Pass factory as 5 u32s, the keccak function handles the 0xff prefix internally
    var factory: array<u32, 5>;
    for (var i = 0u; i < 5u; i++) {
        factory[i] = constants.factory[i];
    }

    var proxy_code_hash: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) {
        proxy_code_hash[i] = constants.proxy_code_hash[i];
    }

    let address = keccak256_85_address(factory, gnosis_salt, proxy_code_hash);

    // Step 3: Check if this address is smaller than the current best
    let current_best0 = atomicLoad(&best.addr0);
    let current_best1 = atomicLoad(&best.addr1);
    let current_best2 = atomicLoad(&best.addr2);
    let current_best3 = atomicLoad(&best.addr3);
    let current_best4 = atomicLoad(&best.addr4);

    if (is_smaller(address, current_best0, current_best1, current_best2, current_best3, current_best4)) {
        // Attempt to update (non-atomic update - may have races but that's acceptable for mining)
        atomicStore(&best.addr0, address[0]);
        atomicStore(&best.addr1, address[1]);
        atomicStore(&best.addr2, address[2]);
        atomicStore(&best.addr3, address[3]);
        atomicStore(&best.addr4, address[4]);
        atomicStore(&best.nonce_low, nonce_low);
        atomicStore(&best.nonce_high, nonce_high);
        atomicStore(&best.found, 1u);
    }
}
