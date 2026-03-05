// secp256k1 field arithmetic: u256 type + modular ops over p = 2^256 - 2^32 - 977
//
// Types:  u256 = array<u32, 8>  (little-endian limbs)
// Consts: SECP256K1_P, U256_ZERO, U256_ONE
// Ops:    u256_eq, u256_gte, u256_add, u256_sub, u256_add_u32
//         mod_add, mod_sub, mod_mul, mod_sqr, mod_dbl, mod_mul3, mod_mul8, mod_inv
//         mul32 (u32 * u32 -> u64 via half-word)

const SECP256K1_P = array<u32, 8>(
    0xFFFFFC2Fu, 0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu,
    0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu
);

const U256_ZERO = array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const U256_ONE  = array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);

// ── 32-bit helpers ──────────────────────────────────────────────────

fn add32c(a: u32, b: u32, c: u32) -> vec2<u32> {
    let s1 = a + b;
    let c1 = select(0u, 1u, s1 < a);
    let s2 = s1 + c;
    let c2 = select(0u, 1u, s2 < s1);
    return vec2<u32>(s2, c1 + c2);
}

fn sub32b(a: u32, b: u32, w: u32) -> vec2<u32> {
    let d1 = a - b;
    let b1 = select(0u, 1u, a < b);
    let d2 = d1 - w;
    let b2 = select(0u, 1u, d1 < w);
    return vec2<u32>(d2, b1 + b2);
}

fn mul32(a: u32, b: u32) -> vec2<u32> {
    let al = a & 0xFFFFu;
    let ah = a >> 16u;
    let bl = b & 0xFFFFu;
    let bh = b >> 16u;
    let p0 = al * bl;
    let p1 = ah * bl;
    let p2 = al * bh;
    let p3 = ah * bh;
    let mid = (p0 >> 16u) + (p1 & 0xFFFFu) + (p2 & 0xFFFFu);
    let lo = (p0 & 0xFFFFu) | ((mid & 0xFFFFu) << 16u);
    let hi = p3 + (p1 >> 16u) + (p2 >> 16u) + (mid >> 16u);
    return vec2<u32>(lo, hi);
}

// ── u256 arithmetic ─────────────────────────────────────────────────

fn u256_eq(a: array<u32, 8>, b: array<u32, 8>) -> bool {
    return a[0] == b[0] && a[1] == b[1] && a[2] == b[2] && a[3] == b[3] &&
           a[4] == b[4] && a[5] == b[5] && a[6] == b[6] && a[7] == b[7];
}

fn u256_gte(a: array<u32, 8>, b: array<u32, 8>) -> bool {
    for (var i = 7i; i >= 0i; i--) {
        if (a[i] > b[i]) { return true; }
        if (a[i] < b[i]) { return false; }
    }
    return true;
}

fn u256_add(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 9> {
    var r: array<u32, 9>;
    var c = 0u;
    for (var i = 0u; i < 8u; i++) {
        let t = add32c(a[i], b[i], c);
        r[i] = t.x;
        c = t.y;
    }
    r[8] = c;
    return r;
}

fn u256_sub(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    var r: array<u32, 8>;
    var w = 0u;
    for (var i = 0u; i < 8u; i++) {
        let t = sub32b(a[i], b[i], w);
        r[i] = t.x;
        w = t.y;
    }
    return r;
}

fn u256_add_u32(a: array<u32, 8>, v: u32) -> array<u32, 8> {
    var r: array<u32, 8>;
    let t0 = add32c(a[0], v, 0u);
    r[0] = t0.x;
    var c = t0.y;
    for (var i = 1u; i < 8u; i++) {
        let t = add32c(a[i], 0u, c);
        r[i] = t.x;
        c = t.y;
    }
    return r;
}

// ── Modular arithmetic (mod SECP256K1_P) ────────────────────────────

fn mod_add(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    let sum = u256_add(a, b);
    var r: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { r[i] = sum[i]; }
    if (sum[8] != 0u || u256_gte(r, SECP256K1_P)) {
        r = u256_sub(r, SECP256K1_P);
    }
    return r;
}

fn mod_sub(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    if (u256_gte(a, b)) {
        return u256_sub(a, b);
    }
    return u256_sub(SECP256K1_P, u256_sub(b, a));
}

// Schoolbook u256 * u256 → u512
fn u256_mul_wide(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { r[i] = 0u; }

    for (var i = 0u; i < 8u; i++) {
        var carry = 0u;
        for (var j = 0u; j < 8u; j++) {
            let p = mul32(a[i], b[j]);
            let t1 = add32c(r[i + j], p.x, carry);
            r[i + j] = t1.x;
            carry = p.y + t1.y;
        }
        r[i + 8u] = carry;
    }
    return r;
}

// Fast reduction mod p = 2^256 - 0x1000003D1
// wide = lo[0..7] + hi[8..15] * 2^256
//      = lo + hi * (p + c)  where c = 0x1000003D1
//      = lo + hi * c  (mod p)
fn mod_reduce(wide: array<u32, 16>) -> array<u32, 8> {
    var r: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { r[i] = wide[i]; }

    // Pass 1: add hi[8..15] * 0x3D1 and hi[8..15] shifted left by 32 bits
    var carry_lo = 0u;
    var carry_hi = 0u;
    for (var i = 0u; i < 8u; i++) {
        let p = mul32(wide[i + 8u], 0x3D1u);
        let t1 = add32c(r[i], p.x, carry_lo);
        r[i] = t1.x;
        let t2 = add32c(p.y, t1.y, carry_hi);
        carry_lo = t2.x;
        carry_hi = t2.y;
    }
    // overflow from hi * 0x3D1
    var ov_lo = carry_lo;
    var ov_hi = carry_hi;

    // Add hi[8..15] << 32 (i.e. wide[8..14] into r[1..7])
    carry_lo = 0u;
    for (var i = 1u; i < 8u; i++) {
        let t = add32c(r[i], wide[i + 7u], carry_lo);
        r[i] = t.x;
        carry_lo = t.y;
    }
    // Add remaining carries to overflow
    let ov_add = add32c(ov_lo, carry_lo + wide[15], 0u);
    ov_lo = ov_add.x;
    ov_hi = ov_hi + ov_add.y;

    // Pass 2: reduce overflow * c where c = 0x1000003D1
    // overflow is small (at most ~35 bits), so overflow * 0x3D1 fits easily
    let p2 = mul32(ov_lo, 0x3D1u);
    let p3 = mul32(ov_hi, 0x3D1u);

    // Add p2 to r[0], p3 to r[1]
    var c = 0u;
    let t0 = add32c(r[0], p2.x, 0u);
    r[0] = t0.x;
    c = t0.y;
    let t1 = add32c(r[1], p2.y + p3.x, c);
    r[1] = t1.x;
    c = t1.y + p3.y;

    // Add ov << 32 to r[1..2]
    let t1b = add32c(r[1], ov_lo, 0u);
    r[1] = t1b.x;
    let t2b = add32c(r[2], ov_hi + t1b.y, c);
    r[2] = t2b.x;
    c = t2b.y;

    // Propagate remaining carry
    for (var i = 3u; i < 8u; i++) {
        if (c == 0u) { break; }
        let t = add32c(r[i], c, 0u);
        r[i] = t.x;
        c = t.y;
    }

    // At most 2 conditional subtractions
    if (u256_gte(r, SECP256K1_P)) { r = u256_sub(r, SECP256K1_P); }
    if (u256_gte(r, SECP256K1_P)) { r = u256_sub(r, SECP256K1_P); }
    return r;
}

// Optimized squaring: a^2 using symmetry (36 mul32 instead of 64)
// a^2 = sum_i a[i]^2 * 2^(64i) + 2 * sum_{i<j} a[i]*a[j] * 2^(32(i+j))
fn u256_sqr_wide(a: array<u32, 8>) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { r[i] = 0u; }

    // Cross terms (i < j): 28 mul32 calls
    for (var i = 0u; i < 7u; i++) {
        var carry = 0u;
        for (var j = i + 1u; j < 8u; j++) {
            let p = mul32(a[i], a[j]);
            let t1 = add32c(r[i + j], p.x, carry);
            r[i + j] = t1.x;
            carry = p.y + t1.y;
        }
        r[i + 8u] = r[i + 8u] + carry;
    }

    // Double all cross terms (left shift by 1 bit)
    var top = 0u;
    for (var i = 0u; i < 16u; i++) {
        let new_val = (r[i] << 1u) | top;
        top = r[i] >> 31u;
        r[i] = new_val;
    }

    // Add diagonal terms: a[i]^2 (8 mul32 calls)
    var carry2 = 0u;
    for (var i = 0u; i < 8u; i++) {
        let p = mul32(a[i], a[i]);
        let t1 = add32c(r[2u * i], p.x, carry2);
        r[2u * i] = t1.x;
        let t2 = add32c(r[2u * i + 1u], p.y, t1.y);
        r[2u * i + 1u] = t2.x;
        carry2 = t2.y;
    }

    return r;
}

fn mod_mul(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    return mod_reduce(u256_mul_wide(a, b));
}

fn mod_sqr(a: array<u32, 8>) -> array<u32, 8> {
    return mod_reduce(u256_sqr_wide(a));
}

fn mod_dbl(a: array<u32, 8>) -> array<u32, 8> {
    return mod_add(a, a);
}

fn mod_mul3(a: array<u32, 8>) -> array<u32, 8> {
    return mod_add(mod_dbl(a), a);
}

fn mod_mul8(a: array<u32, 8>) -> array<u32, 8> {
    return mod_dbl(mod_dbl(mod_dbl(a)));
}

// Modular inverse via Fermat: a^(p-2) mod p
fn mod_inv(a: array<u32, 8>) -> array<u32, 8> {
    // Addition chain for p-2 = 0xFFFF...FFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2D
    var x2 = mod_sqr(a);
    x2 = mod_mul(x2, a);          // a^3 = a^(2^2-1)
    var x3 = mod_sqr(x2);
    x3 = mod_mul(x3, a);          // a^(2^3-1)
    var x6 = x3;
    for (var i = 0u; i < 3u; i++) { x6 = mod_sqr(x6); }
    x6 = mod_mul(x6, x3);         // a^(2^6-1)
    var x9 = x6;
    for (var i = 0u; i < 3u; i++) { x9 = mod_sqr(x9); }
    x9 = mod_mul(x9, x3);         // a^(2^9-1)
    var x11 = x9;
    for (var i = 0u; i < 2u; i++) { x11 = mod_sqr(x11); }
    x11 = mod_mul(x11, x2);       // a^(2^11-1)
    var x22 = x11;
    for (var i = 0u; i < 11u; i++) { x22 = mod_sqr(x22); }
    x22 = mod_mul(x22, x11);      // a^(2^22-1)
    var x44 = x22;
    for (var i = 0u; i < 22u; i++) { x44 = mod_sqr(x44); }
    x44 = mod_mul(x44, x22);      // a^(2^44-1)
    var x88 = x44;
    for (var i = 0u; i < 44u; i++) { x88 = mod_sqr(x88); }
    x88 = mod_mul(x88, x44);      // a^(2^88-1)
    var x176 = x88;
    for (var i = 0u; i < 88u; i++) { x176 = mod_sqr(x176); }
    x176 = mod_mul(x176, x88);    // a^(2^176-1)
    var x220 = x176;
    for (var i = 0u; i < 44u; i++) { x220 = mod_sqr(x220); }
    x220 = mod_mul(x220, x44);    // a^(2^220-1)
    var x223 = x220;
    for (var i = 0u; i < 3u; i++) { x223 = mod_sqr(x223); }
    x223 = mod_mul(x223, x3);     // a^(2^223-1)

    // Now build p-2 from MSB:
    // p-2 = 0xFFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFF_FFFFFFFE_FFFFFC2D
    // bits 255..33 = 223 ones (we have x223 = a^(2^223-1))
    // bit 32 = 0
    // bits 31..0 = 0xFFFFFC2D

    // Remaining 33 bits of p-2: bit 32 = 0, bits 31..0 = 0xFFFFFC2D
    // bit 32 = 0 → 1 squaring (no multiply)
    // bits 31..10 = 22 ones → 22 squarings then multiply by x22
    // bits 9..0 = 0x02D → 10 individual double-and-add steps
    var result = x223;
    for (var i = 0u; i < 23u; i++) { result = mod_sqr(result); }
    // exp = (2^223-1)*2^23. Multiply by x22 to add 22 ones at bits 31..10
    result = mod_mul(result, x22);
    // Now process bits 9..0 of 0xFFFFFC2D = 0x02D = 0b00_0010_1101
    result = mod_sqr(result); // bit 9 = 0
    result = mod_sqr(result); // bit 8 = 0
    result = mod_sqr(result); // bit 7 = 0
    result = mod_sqr(result); // bit 6 = 0
    result = mod_sqr(result); // bit 5 = 1
    result = mod_mul(result, a);
    result = mod_sqr(result); // bit 4 = 0
    result = mod_sqr(result); // bit 3 = 1
    result = mod_mul(result, a);
    result = mod_sqr(result); // bit 2 = 1
    result = mod_mul(result, a);
    result = mod_sqr(result); // bit 1 = 0
    result = mod_sqr(result); // bit 0 = 1
    result = mod_mul(result, a);

    return result;
}
