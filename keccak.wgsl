// WebGPU Compute Shader for Keccak256 (Create2 Crunching) - Optimized 2D Dispatch

alias u64 = vec2<u32>;

fn make_u64(low: u32, high: u32) -> u64 { return vec2<u32>(low, high); }
fn xor_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x ^ b.x, a.y ^ b.y); }
fn and_u64(a: u64, b: u64) -> u64 { return vec2<u32>(a.x & b.x, a.y & b.y); }
fn not_u64(a: u64) -> u64 { return vec2<u32>(~a.x, ~a.y); }

// Optimized rotates
fn rol_lo(x: u64, n: u32) -> u64 {
    return vec2<u32>((x.x << n) | (x.y >> (32u - n)), (x.y << n) | (x.x >> (32u - n)));
}

fn rol_hi(x: u64, n: u32) -> u64 {
    let shift = n - 32u;
    return vec2<u32>((x.y << shift) | (x.x >> (32u - shift)), (x.x << shift) | (x.y >> (32u - shift)));
}

struct Params {
    nonce_high: u32,
    threshold: u32,
    mode: u32,
    padding: u32,
}

@group(0) @binding(0) var<storage, read> template_state: array<u32, 50>;
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> solutions: array<u32, 2>;

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
    
    // Unrolled loop for i = 0
    b[0] = (*a)[0]; b[1] = (*a)[1]; b[2] = (*a)[2]; b[3] = (*a)[3]; b[4] = (*a)[4];
    (*a)[0] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[1] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[2] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[3] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[4] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    // i = 5
    b[0] = (*a)[5]; b[1] = (*a)[6]; b[2] = (*a)[7]; b[3] = (*a)[8]; b[4] = (*a)[9];
    (*a)[5] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[6] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[7] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[8] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[9] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    // i = 10
    b[0] = (*a)[10]; b[1] = (*a)[11]; b[2] = (*a)[12]; b[3] = (*a)[13]; b[4] = (*a)[14];
    (*a)[10] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[11] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[12] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[13] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[14] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    // i = 15
    b[0] = (*a)[15]; b[1] = (*a)[16]; b[2] = (*a)[17]; b[3] = (*a)[18]; b[4] = (*a)[19];
    (*a)[15] = xor_u64(b[0], and_u64(not_u64(b[1]), b[2]));
    (*a)[16] = xor_u64(b[1], and_u64(not_u64(b[2]), b[3]));
    (*a)[17] = xor_u64(b[2], and_u64(not_u64(b[3]), b[4]));
    (*a)[18] = xor_u64(b[3], and_u64(not_u64(b[4]), b[0]));
    (*a)[19] = xor_u64(b[4], and_u64(not_u64(b[0]), b[1]));

    // i = 20
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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    var state: array<u64, 25>;
    for (var i = 0u; i < 25u; i++) { state[i] = make_u64(template_state[i*2], template_state[i*2 + 1]); }

    // X dimension is 65535 * 64 items = 4194240
    let index = global_id.x + global_id.y * 4194240u;
    
    let nonce_low = index;
    let nonce_high = params.nonce_high;

    let n0 = (nonce_low) & 0xFFu;
    let n1 = (nonce_low >> 8u) & 0xFFu;
    let n2 = (nonce_low >> 16u) & 0xFFu;
    let n3 = (nonce_low >> 24u) & 0xFFu;

    let s5y_mask = 0x000000FFu;
    state[5].y = (state[5].y & s5y_mask) | (n0 << 8u) | (n1 << 16u) | (n2 << 24u);

    let n4 = (nonce_high) & 0xFFu;
    let n5 = (nonce_high >> 8u) & 0xFFu;
    let n6 = (nonce_high >> 16u) & 0xFFu;
    let n7 = (nonce_high >> 24u) & 0xFFu;

    state[6].x = n3 | (n4 << 8u) | (n5 << 16u) | (n6 << 24u);
    let s6y_mask = 0xFFFFFF00u;
    state[6].y = (state[6].y & s6y_mask) | n7;

    keccakf(&state);

    let digest_word0 = state[1].y;
    // Benchmark check (simplistic)
    if (digest_word0 == 0u) {
        solutions[0] = nonce_low;
        solutions[1] = nonce_high;
    }
}

