// Copy of keccak.wgsl but modified to output the full digest for verification
// ... (Include all helper functions from keccak.wgsl)

// 64-bit integer emulation
alias u64 = vec2<u32>;
fn make_u64(low: u32, high: u32) -> u64 { return vec2<u32>(low, high); }
fn xor_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x ^ b.x, a.y ^ b.y); }
fn and_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x & b.x, a.y & b.y); }
fn not_u64(a: u64) -> u64 { return vec2<u32>(~a.x, ~a.y); }
fn rol_u64(x: u64, n: u32) -> u64 {
    if (n == 0u) { return x; }
    if (n == 32u) { return vec2<u32>(x.y, x.x); }
    if (n < 32u) { return vec2<u32>((x.x << n) | (x.y >> (32u - n)), (x.y << n) | (x.x >> (32u - n))); }
    let shift = n - 32u;
    return vec2<u32>((x.y << shift) | (x.x >> (32u - shift)), (x.x << shift) | (x.y >> (32u - shift)));
}

struct Params {
    nonce_high: u32,
    threshold: u32,
    mode: u32,
}

@group(0) @binding(0) var<storage, read> template_state: array<u32, 50>;
@group(0) @binding(1) var<uniform> params: Params;
// Output buffer: First 32 bytes = Hash output. Second 32 bytes = Debug info?
@group(0) @binding(2) var<storage, read_write> output: array<u32, 8>;

// Keccak functions (theta, rhoPi, chi, iota, keccakf) - Simplified copy paste
// To save space/tokens I will assume the same implementation as keccak.wgsl
// I will just implement the `keccakf` wrapper which calls the steps.
// Actually I need to include them.

fn theta(a: ptr<function, array<u64, 25>>) {
    var b: array<u64, 5>;
    var t: u64;
    b[0] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[0], (*a)[5]), (*a)[10]), (*a)[15]), (*a)[20]);
    b[1] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[1], (*a)[6]), (*a)[11]), (*a)[16]), (*a)[21]);
    b[2] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[2], (*a)[7]), (*a)[12]), (*a)[17]), (*a)[22]);
    b[3] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[3], (*a)[8]), (*a)[13]), (*a)[18]), (*a)[23]);
    b[4] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[4], (*a)[9]), (*a)[14]), (*a)[19]), (*a)[24]);
    t = xor_u64(b[4], rol_u64(b[1], 1u)); (*a)[0] = xor_u64((*a)[0], t); (*a)[5] = xor_u64((*a)[5], t); (*a)[10] = xor_u64((*a)[10], t); (*a)[15] = xor_u64((*a)[15], t); (*a)[20] = xor_u64((*a)[20], t);
    t = xor_u64(b[0], rol_u64(b[2], 1u)); (*a)[1] = xor_u64((*a)[1], t); (*a)[6] = xor_u64((*a)[6], t); (*a)[11] = xor_u64((*a)[11], t); (*a)[16] = xor_u64((*a)[16], t); (*a)[21] = xor_u64((*a)[21], t);
    t = xor_u64(b[1], rol_u64(b[3], 1u)); (*a)[2] = xor_u64((*a)[2], t); (*a)[7] = xor_u64((*a)[7], t); (*a)[12] = xor_u64((*a)[12], t); (*a)[17] = xor_u64((*a)[17], t); (*a)[22] = xor_u64((*a)[22], t);
    t = xor_u64(b[2], rol_u64(b[4], 1u)); (*a)[3] = xor_u64((*a)[3], t); (*a)[8] = xor_u64((*a)[8], t); (*a)[13] = xor_u64((*a)[13], t); (*a)[18] = xor_u64((*a)[18], t); (*a)[23] = xor_u64((*a)[23], t);
    t = xor_u64(b[3], rol_u64(b[0], 1u)); (*a)[4] = xor_u64((*a)[4], t); (*a)[9] = xor_u64((*a)[9], t); (*a)[14] = xor_u64((*a)[14], t); (*a)[19] = xor_u64((*a)[19], t); (*a)[24] = xor_u64((*a)[24], t);
}

fn rhoPi(a: ptr<function, array<u64, 25>>) {
    var t: u64; var b0: u64;
    t = (*a)[1]; b0 = (*a)[10]; (*a)[10] = rol_u64(t, 1u);
    t = b0; b0 = (*a)[7]; (*a)[7] = rol_u64(t, 3u);
    t = b0; b0 = (*a)[11]; (*a)[11] = rol_u64(t, 6u);
    t = b0; b0 = (*a)[17]; (*a)[17] = rol_u64(t, 10u);
    t = b0; b0 = (*a)[18]; (*a)[18] = rol_u64(t, 15u);
    t = b0; b0 = (*a)[3]; (*a)[3] = rol_u64(t, 21u);
    t = b0; b0 = (*a)[5]; (*a)[5] = rol_u64(t, 28u);
    t = b0; b0 = (*a)[16]; (*a)[16] = rol_u64(t, 36u);
    t = b0; b0 = (*a)[8]; (*a)[8] = rol_u64(t, 45u);
    t = b0; b0 = (*a)[21]; (*a)[21] = rol_u64(t, 55u);
    t = b0; b0 = (*a)[24]; (*a)[24] = rol_u64(t, 2u);
    t = b0; b0 = (*a)[4]; (*a)[4] = rol_u64(t, 14u);
    t = b0; b0 = (*a)[15]; (*a)[15] = rol_u64(t, 27u);
    t = b0; b0 = (*a)[23]; (*a)[23] = rol_u64(t, 41u);
    t = b0; b0 = (*a)[19]; (*a)[19] = rol_u64(t, 56u);
    t = b0; b0 = (*a)[13]; (*a)[13] = rol_u64(t, 8u);
    t = b0; b0 = (*a)[12]; (*a)[12] = rol_u64(t, 25u);
    t = b0; b0 = (*a)[2]; (*a)[2] = rol_u64(t, 43u);
    t = b0; b0 = (*a)[20]; (*a)[20] = rol_u64(t, 62u);
    t = b0; b0 = (*a)[14]; (*a)[14] = rol_u64(t, 18u);
    t = b0; b0 = (*a)[22]; (*a)[22] = rol_u64(t, 39u);
    t = b0; b0 = (*a)[9]; (*a)[9] = rol_u64(t, 61u);
    t = b0; b0 = (*a)[6]; (*a)[6] = rol_u64(t, 20u);
    t = b0; b0 = (*a)[1]; (*a)[1] = rol_u64(t, 44u);
}

fn chi(a: ptr<function, array<u64, 25>>) {
    var b: array<u64, 5>;
    for (var i = 0u; i < 25u; i += 5u) {
        b[0] = (*a)[i + 0]; b[1] = (*a)[i + 1]; b[2] = (*a)[i + 2]; b[3] = (*a)[i + 3]; b[4] = (*a)[i + 4];
        (*a)[i + 0] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
        (*a)[i + 1] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
        (*a)[i + 2] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
        (*a)[i + 3] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
        (*a)[i + 4] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));
    }
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

@compute @workgroup_size(1)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    var state: array<u64, 25>;
    for (var i = 0u; i < 25u; i++) { state[i] = make_u64(template_state[i*2], template_state[i*2 + 1]); }

    // Use hardcoded nonce for single test
    // Nonce Low from params via global_id (we will dispatch 1 thread with correct nonce?)
    // No, better to pass nonce via uniform/buffer for single test.
    // Or assume global_id.x is the Low Nonce.

    // We will set global_id.x to nonceLow in the dispatch (offset) or just pass it?
    // Dispatch is (1,1,1). global_id.x = 0.
    // So we need to ADD the nonceLow.
    // Or just overwrite it.

    // Let's assume we use the injected nonce logic:
    let nonce_low = params.threshold; // Hack: passing nonceLow via 'threshold' param for this test?
    // Actually, let's just use the values passed in uniforms if possible.
    // But uniform is `params`.
    // params.nonce_high is High.
    // params.threshold - use this for Low?

    let nLow = params.threshold;
    let nHigh = params.nonce_high;

    // Apply Nonce Injection Logic
    let n0 = (nLow) & 0xFFu;
    let n1 = (nLow >> 8u) & 0xFFu;
    let n2 = (nLow >> 16u) & 0xFFu;
    let n3 = (nLow >> 24u) & 0xFFu;

    let s5y_mask = 0x000000FFu;
    state[5].y = (state[5].y & s5y_mask) | (n0 << 8u) | (n1 << 16u) | (n2 << 24u);

    let n4 = (nHigh) & 0xFFu;
    let n5 = (nHigh >> 8u) & 0xFFu;
    let n6 = (nHigh >> 16u) & 0xFFu;
    let n7 = (nHigh >> 24u) & 0xFFu;

    state[6].x = n3 | (n4 << 8u) | (n5 << 16u) | (n6 << 24u);
    let s6y_mask = 0xFFFFFF00u;
    state[6].y = (state[6].y & s6y_mask) | n7;

    keccakf(&state);

    // Output digest
    // sponge[12]..sponge[15] -> state[1].y (u32)
    // sponge[16]..sponge[19] -> state[2].x (u32)
    // sponge[20]..sponge[23] -> state[2].y (u32)
    // sponge[24]..sponge[27] -> state[3].x (u32)
    // sponge[28]..sponge[31] -> state[3].y (u32)

    // Create2 hash is 32 bytes.
    // sponge + 12 is start.
    // Bytes 0-3: state[1].y
    // Bytes 4-7: state[2].x
    // Bytes 8-11: state[2].y
    // Bytes 12-15: state[3].x
    // Bytes 16-19: state[3].y
    // Bytes 20-23: state[4].x
    // Bytes 24-27: state[4].y
    // Bytes 28-31: state[0].x ??? No.
    // sponge is linear.
    // state[0] = 0..7
    // state[1] = 8..15
    // state[2] = 16..23
    // state[3] = 24..31
    // state[4] = 32..39

    // Digest starts at 12.
    // 12..15 in state[1] (High part).
    // 16..23 in state[2] (Low, High).
    // 24..31 in state[3] (Low, High).
    // 32..39 in state[4] (Low, High). Wait, Create2 is 32 bytes?
    // Keccak output is 32 bytes?
    // 12 + 32 = 44.
    // So 12..43.
    // 32..39 in state[4].
    // 40..43 in state[5] (Low part).

    // So we output:
    output[0] = state[1].y;
    output[1] = state[2].x;
    output[2] = state[2].y;
    output[3] = state[3].x;
    output[4] = state[3].y;
    output[5] = state[4].x;
    output[6] = state[4].y;
    output[7] = state[5].x;
}

