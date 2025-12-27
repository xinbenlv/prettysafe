// WebGPU Compute Shader for Keccak256 (Create2 Crunching)
// Translated from OpenCL kernel

// 64-bit integer emulation using vec2<u32> (low, high)
alias u64 = vec2<u32>;

fn make_u64(low: u32, high: u32) -> u64 {
    return vec2<u32>(low, high);
}

fn xor_u64(a: u64, b: u64) -> u64 {
    return vec2<u32>(a.x ^ b.x, a.y ^ b.y);
}

fn and_u64(a: u64, b: u64) -> u64 {
    return vec2<u32>(a.x & b.x, a.y & b.y);
}

fn not_u64(a: u64) -> u64 {
    return vec2<u32>(~a.x, ~a.y);
}

fn rol_u64(x: u64, n: u32) -> u64 {
    if (n == 0u) { return x; }
    if (n == 32u) { return vec2<u32>(x.y, x.x); }
    if (n < 32u) {
        return vec2<u32>(
            (x.x << n) | (x.y >> (32u - n)),
            (x.y << n) | (x.x >> (32u - n))
        );
    }
    // n > 32
    let shift = n - 32u;
    return vec2<u32>(
        (x.y << shift) | (x.x >> (32u - shift)),
        (x.x << shift) | (x.y >> (32u - shift))
    );
}

// Constants passed from host
struct Params {
    nonce_high: u32,
    threshold: u32, // For leading zeroes check (simplified)
    mode: u32,      // 0 = simple check, 1 = leading zero count?
}

// We use a storage buffer for the template state to avoid recompilation
// The template state contains the pre-computed sponge state (S_1...S_84 + padding)
// except for the nonce part which we inject.
@group(0) @binding(0) var<storage, read> template_state: array<u32, 50>; // 25 * 2 u32s
@group(0) @binding(1) var<uniform> params: Params;
@group(0) @binding(2) var<storage, read_write> solutions: array<u32, 2>; // low, high of found nonce

// Keccak-f[1600] implementation
// Working on local state array<u64, 25>

fn theta(a: ptr<function, array<u64, 25>>) {
    var b: array<u64, 5>;
    var t: u64;

    b[0] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[0], (*a)[5]), (*a)[10]), (*a)[15]), (*a)[20]);
    b[1] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[1], (*a)[6]), (*a)[11]), (*a)[16]), (*a)[21]);
    b[2] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[2], (*a)[7]), (*a)[12]), (*a)[17]), (*a)[22]);
    b[3] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[3], (*a)[8]), (*a)[13]), (*a)[18]), (*a)[23]);
    b[4] = xor_u64(xor_u64(xor_u64(xor_u64((*a)[4], (*a)[9]), (*a)[14]), (*a)[19]), (*a)[24]);

    t = xor_u64(b[4], rol_u64(b[1], 1u));
    (*a)[0] = xor_u64((*a)[0], t); (*a)[5] = xor_u64((*a)[5], t); (*a)[10] = xor_u64((*a)[10], t); (*a)[15] = xor_u64((*a)[15], t); (*a)[20] = xor_u64((*a)[20], t);

    t = xor_u64(b[0], rol_u64(b[2], 1u));
    (*a)[1] = xor_u64((*a)[1], t); (*a)[6] = xor_u64((*a)[6], t); (*a)[11] = xor_u64((*a)[11], t); (*a)[16] = xor_u64((*a)[16], t); (*a)[21] = xor_u64((*a)[21], t);

    t = xor_u64(b[1], rol_u64(b[3], 1u));
    (*a)[2] = xor_u64((*a)[2], t); (*a)[7] = xor_u64((*a)[7], t); (*a)[12] = xor_u64((*a)[12], t); (*a)[17] = xor_u64((*a)[17], t); (*a)[22] = xor_u64((*a)[22], t);

    t = xor_u64(b[2], rol_u64(b[4], 1u));
    (*a)[3] = xor_u64((*a)[3], t); (*a)[8] = xor_u64((*a)[8], t); (*a)[13] = xor_u64((*a)[13], t); (*a)[18] = xor_u64((*a)[18], t); (*a)[23] = xor_u64((*a)[23], t);

    t = xor_u64(b[3], rol_u64(b[0], 1u));
    (*a)[4] = xor_u64((*a)[4], t); (*a)[9] = xor_u64((*a)[9], t); (*a)[14] = xor_u64((*a)[14], t); (*a)[19] = xor_u64((*a)[19], t); (*a)[24] = xor_u64((*a)[24], t);
}

fn rhoPi(a: ptr<function, array<u64, 25>>) {
    var t: u64;
    var b0: u64;

    t = (*a)[1];
    b0 = (*a)[10];
    (*a)[10] = rol_u64(t, 1u);

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

fn iota(a: ptr<function, array<u64, 25>>, roundConst: u64) {
    (*a)[0] = xor_u64((*a)[0], roundConst);
}

fn keccakf(a: ptr<function, array<u64, 25>>) {
    // 24 rounds
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

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) global_id: vec3<u32>) {
    var state: array<u64, 25>;

    // 1. Load template state
    for (var i = 0u; i < 25u; i++) {
        state[i] = make_u64(template_state[i*2], template_state[i*2 + 1]);
    }

    // 2. Inject nonce
    // Nonce structure:
    //   Low 32 bits from global_id.x
    //   High 32 bits from params.nonce_high
    // Location in sponge: bytes 45..52
    //   Byte 45 is in state[5] (bytes 40..47), offset 5 -> byte 1 of high word
    //   Byte 48 is in state[6] (bytes 48..55), offset 0 -> byte 0 of low word

    let nonce_low = global_id.x;
    let nonce_high = params.nonce_high;

    // state[5].high contains: [byte 7][byte 6][byte 5][byte 4] of u64 word
    // which corresponds to sponge bytes [47][46][45][44]
    // We need to overwrite bytes 45, 46, 47 with nonce_low's first 3 bytes.
    // byte 44 corresponds to d_message[3] (already in template)

    // nonce_low: [b3][b2][b1][b0]
    // sponge[45] = b0
    // sponge[46] = b1
    // sponge[47] = b2
    // sponge[48] = b3 (goes to state[6].low)

    let n0 = (nonce_low) & 0xFFu;
    let n1 = (nonce_low >> 8u) & 0xFFu;
    let n2 = (nonce_low >> 16u) & 0xFFu;
    let n3 = (nonce_low >> 24u) & 0xFFu;

    // state[5].y (high u32) = [47][46][45][44]
    // Mask out top 3 bytes (0xFFFFFF00 is wrong, we want to Keep bottom byte)
    // We want to KEEP byte 0 (sponge[44]) and OVERWRITE bytes 1,2,3.
    let s5y_mask = 0x000000FFu;
    let s5y_new = (state[5].y & s5y_mask) | (n0 << 8u) | (n1 << 16u) | (n2 << 24u);
    state[5].y = s5y_new;

    // sponge[48] = b3
    // sponge[49] = nonce_high[0]
    // sponge[50] = nonce_high[1]
    // sponge[51] = nonce_high[2]
    // sponge[52] = nonce_high[3]

    let n4 = (nonce_high) & 0xFFu;
    let n5 = (nonce_high >> 8u) & 0xFFu;
    let n6 = (nonce_high >> 16u) & 0xFFu;
    let n7 = (nonce_high >> 24u) & 0xFFu;

    // state[6].x (low u32) = [51][50][49][48]
    // We overwrite ALL bytes of low word with n3, n4, n5, n6
    state[6].x = n3 | (n4 << 8u) | (n5 << 16u) | (n6 << 24u);

    // state[6].y (high u32) = [55][54][53][52]
    // We need to overwrite byte 0 (sponge[52]) with n7
    // and keep bytes 1,2,3 (sponge[53]..[55] which are S_53..S_55)

    let s6y_mask = 0xFFFFFF00u;
    let s6y_new = (state[6].y & s6y_mask) | n7;
    state[6].y = s6y_new;

    // 3. Run Keccak
    keccakf(&state);

    // 4. Check result
    // Hash is in state[0], state[1], state[2], state[3]... (first 32 bytes)
    // Wait, the digest is at `sponge + 12`.
    // sponge[12] is start of digest.
    // sponge[12] is in state[1].high (bytes 8..15 of sponge, so bytes 4..7 of u64, i.e., state[1].y)
    // state[1].y contains sponge[12]..sponge[15]

    // OpenCL checks `hasLeading` on `digest`.
    // `hasLeading` checks first N bytes are 0.
    // digest[0] is sponge[12] -> state[1].y byte 0.

    // Let's grab the first word of the digest (4 bytes).
    let digest_word0 = state[1].y;

    // Note on Endianness:
    // WGSL u32 is little endian usually?
    // sponge[12] is the LSB of state[1].y.
    // So if state[1].y == 0, then sponge[12]..[15] are 0.

    // Checking leading zeroes threshold.
    // For simplicity, we just check if the masked word is 0.
    // If params.threshold is 4 (bytes), we check if digest_word0 == 0.
    // If threshold is 3, we check digest_word0 & 0x00FFFFFF == 0.

    // To allow arbitrary threshold check without branching too much:
    // We can just support full zero check for first word for now as benchmark.
    // Create2 Crunch usually looks for lots of zeroes.

    // Using atomic store to avoid race condition on finding solution
    // But since we just want to find ONE, we can race.

    if ((digest_word0 & 0xFFFFFFFFu) == 0u) { // simplistic check for > 0 zeroes? No, check full word 0.
       // Actually, let's use the threshold mask logic if we passed a mask.
       // But params.threshold is just u32.
       // Let's assume we are looking for at least 3 bytes of zeroes for the benchmark to trigger occasionally?
       // Or usually 0 bytes for speed test?
       // The user said "calculate hash per second".
       // We don't need to find a valid solution to calculate hashrate, just run the algo.
       // But to be correct, let's write if we find something rare.

       if (digest_word0 == 0u) {
           solutions[0] = nonce_low;
           solutions[1] = nonce_high;
       }
    }

    // To prevent optimizer from removing code (though side effects on solutions prevent that),
    // we should ensure the solution write depends on the calculation.
}

