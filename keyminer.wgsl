// GPU Shader: EVM Vanity Address Miner via Private Key Iteration
// Pipeline: private_key → secp256k1_mul(G) → public_key → keccak256 → address[12:32]
//
// All crypto primitives implemented from scratch. Pure 32-bit arithmetic (no native u64).

// ═══════════════════════════════════════════════════════════════════════
// Section 0: 32-bit Arithmetic Helpers
// ═══════════════════════════════════════════════════════════════════════

// Add two u32s with carry-in, returns (sum, carry_out)
fn add32c(a: u32, b: u32, c: u32) -> vec2<u32> {
    let s1 = a + b;
    let c1 = select(0u, 1u, s1 < a);
    let s2 = s1 + c;
    let c2 = select(0u, 1u, s2 < s1);
    return vec2<u32>(s2, c1 + c2);
}

// Subtract two u32s with borrow-in, returns (diff, borrow_out)
fn sub32b(a: u32, b: u32, w: u32) -> vec2<u32> {
    let d1 = a - b;
    let b1 = select(0u, 1u, a < b);
    let d2 = d1 - w;
    let b2 = select(0u, 1u, d1 < w);
    return vec2<u32>(d2, b1 + b2);
}

// Multiply two u32s → (lo, hi) using 16-bit half-words
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

// ═══════════════════════════════════════════════════════════════════════
// Section 1: u256 Arithmetic (little-endian 8×u32 limbs)
// ═══════════════════════════════════════════════════════════════════════

// secp256k1 field prime p = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F
const SECP256K1_P = array<u32, 8>(
    0xFFFFFC2Fu, 0xFFFFFFFEu, 0xFFFFFFFFu, 0xFFFFFFFFu,
    0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu, 0xFFFFFFFFu
);

const U256_ZERO = array<u32, 8>(0u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);
const U256_ONE = array<u32, 8>(1u, 0u, 0u, 0u, 0u, 0u, 0u, 0u);

// Generator point G (affine coordinates)
const GX = array<u32, 8>(
    0x16F81798u, 0x59F2815Bu, 0x2DCE28D9u, 0x029BFCDB,
    0xCE870B07u, 0x55A06295u, 0xF9DCBBACu, 0x79BE667Eu
);
const GY = array<u32, 8>(
    0xFB10D4B8u, 0x9C47D08Fu, 0xA6855419u, 0xFD17B448u,
    0x0E1108A8u, 0x5DA4FBFCu, 0x26A3C465u, 0x483ADA77u
);

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

// a + b → (result[0..7], carry in result[8])
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

// a - b (assumes a >= b)
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

// (a + b) mod p
fn mod_add(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    let sum = u256_add(a, b);
    var r: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { r[i] = sum[i]; }
    if (sum[8] != 0u || u256_gte(r, SECP256K1_P)) {
        r = u256_sub(r, SECP256K1_P);
    }
    return r;
}

// (a - b) mod p
fn mod_sub(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    if (u256_gte(a, b)) {
        return u256_sub(a, b);
    }
    return u256_sub(SECP256K1_P, u256_sub(b, a));
}

// Schoolbook u256 × u256 → u512
fn u256_mul_wide(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 16> {
    var r: array<u32, 16>;
    for (var i = 0u; i < 16u; i++) { r[i] = 0u; }

    for (var i = 0u; i < 8u; i++) {
        var carry = 0u;
        for (var j = 0u; j < 8u; j++) {
            let p = mul32(a[i], b[j]);
            // accumulate: r[i+j] += p.lo + carry
            let t1 = add32c(r[i + j], p.x, carry);
            r[i + j] = t1.x;
            // carry = p.hi + carry_from_add
            carry = p.y + t1.y;
        }
        r[i + 8u] = carry;
    }
    return r;
}

// Modular reduction using secp256k1 special form: p = 2^256 - c, c = 0x1000003D1
// x mod p = x_lo + x_hi * c (mod p), iterate until < 2^256
fn mod_reduce(wide: array<u32, 16>) -> array<u32, 8> {
    var r: array<u32, 8>;
    for (var i = 0u; i < 8u; i++) { r[i] = wide[i]; }

    // Pass 1: add x_hi[8..15] * 0x3D1 to r
    var carry_lo = 0u;
    var carry_hi = 0u;
    for (var i = 0u; i < 8u; i++) {
        let p = mul32(wide[i + 8u], 0x3D1u);
        let t1 = add32c(r[i], p.x, carry_lo);
        r[i] = t1.x;
        // carry = p.hi + t1.carry + carry_hi (previous high carry)
        let t2 = add32c(p.y, t1.y, carry_hi);
        carry_lo = t2.x;
        carry_hi = t2.y;
    }
    // overflow from pass 1 (at most ~33 bits)
    var ov_lo = carry_lo;
    var ov_hi = carry_hi;

    // Pass 2: add x_hi[8..15] << 32 (shifted by one limb) to r
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

    // Pass 3: reduce overflow * c = overflow * 0x3D1 + overflow << 32
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

fn mod_mul(a: array<u32, 8>, b: array<u32, 8>) -> array<u32, 8> {
    return mod_reduce(u256_mul_wide(a, b));
}

fn mod_sqr(a: array<u32, 8>) -> array<u32, 8> {
    return mod_mul(a, a);
}

// 2*a mod p
fn mod_dbl(a: array<u32, 8>) -> array<u32, 8> {
    return mod_add(a, a);
}

// 3*a mod p
fn mod_mul3(a: array<u32, 8>) -> array<u32, 8> {
    return mod_add(mod_dbl(a), a);
}

// 8*a mod p
fn mod_mul8(a: array<u32, 8>) -> array<u32, 8> {
    return mod_dbl(mod_dbl(mod_dbl(a)));
}

// Modular inverse: a^(p-2) mod p via square-and-multiply
// p-2 limbs (LE): [0xFFFFFC2D, 0xFFFFFFFE, 0xFFFFFFFF×6]
fn mod_inv(a: array<u32, 8>) -> array<u32, 8> {
    // Addition chain for efficiency
    var x2 = mod_sqr(a);
    x2 = mod_mul(x2, a);          // a^3 = a^(2^2-1)
    var x3 = mod_sqr(x2);
    x3 = mod_mul(x3, a);          // a^7 = a^(2^3-1)
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
    // From MSB: bits 255..33 = 223 ones (we have x223 = a^(2^223-1))
    // bit 32 = 0
    // bits 31..0 = 0xFFFFFC2D

    // result = x223 << 33  (33 squarings)
    var result = x223;
    for (var i = 0u; i < 33u; i++) { result = mod_sqr(result); }
    // Now result = a^((2^223-1)*2^33)
    // We need to add the exponent bits for bit 32..0:
    // bit 32 = 0 (already 0 from the shift)
    // bits 31..0 = 0xFFFFFC2D

    // Decompose 0xFFFFFC2D:
    // = 0xFFFFFC00 + 0x2D
    // = (2^22-1)*2^10 + 0x2D
    // Top 22 bits (bits 31..10): all ones → multiply by x22, shift 10
    result = mod_mul(result, x22);
    for (var i = 0u; i < 10u; i++) { result = mod_sqr(result); }
    // Now add bits 9..0 of 0xFC2D:
    // 0x...FC2D bits 9..0: 0x02D = 0b00_0010_1101
    // That's: bit 5=1, bit 3=1, bit 2=1, bit 0=1

    // Actually wait. Let me reconsider. 0xFFFFFC2D bits 9..0:
    // 0xC2D = 0b1100_0010_1101, that's 12 bits. bits 9..0 = 0x22D = 0b10_0010_1101
    // Hmm let me just look at it differently.

    // After the x22 multiply and 10 squarings, the exponent so far covers bits 31..10.
    // We still need bits 9..0 of 0xFFFFFC2D.
    // 0xFFFFFC2D & 0x3FF = 0x02D = 45 = 0b00_0010_1101

    // Bits 9..6: 0000 → 4 squarings, no multiply
    // Bit 5: 1 → square, multiply by a
    // Bit 4: 0 → square
    // Bit 3: 1 → square, multiply by a
    // Bit 2: 1 → square, multiply by a
    // Bit 1: 0 → square
    // Bit 0: 1 → square, multiply by a

    // Process bits 9..0 = 0b0000101101
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

// ═══════════════════════════════════════════════════════════════════════
// Section 2: secp256k1 EC Operations (Jacobian Coordinates)
// ═══════════════════════════════════════════════════════════════════════

struct ECPoint {
    x: array<u32, 8>,
    y: array<u32, 8>,
    z: array<u32, 8>,
}

fn ec_identity() -> ECPoint {
    return ECPoint(U256_ZERO, U256_ONE, U256_ZERO);
}

fn ec_is_identity(p: ECPoint) -> bool {
    return u256_eq(p.z, U256_ZERO);
}

// Point doubling (secp256k1: a=0), dbl-2009-l
fn ec_double(p: ECPoint) -> ECPoint {
    if (ec_is_identity(p)) { return p; }

    let aa = mod_sqr(p.x);
    let bb = mod_sqr(p.y);
    let cc = mod_sqr(bb);
    var d = mod_add(p.x, bb);
    d = mod_sqr(d);
    d = mod_sub(d, aa);
    d = mod_sub(d, cc);
    d = mod_dbl(d);
    let e = mod_mul3(aa);
    let f = mod_sqr(e);

    var x3 = mod_sub(f, mod_dbl(d));
    var y3 = mod_sub(d, x3);
    y3 = mod_mul(e, y3);
    y3 = mod_sub(y3, mod_mul8(cc));
    var z3 = mod_mul(p.y, p.z);
    z3 = mod_dbl(z3);

    return ECPoint(x3, y3, z3);
}

// Mixed addition: P (Jacobian) + Q (affine, z=1)
fn ec_add_mixed(p: ECPoint, qx: array<u32, 8>, qy: array<u32, 8>) -> ECPoint {
    if (ec_is_identity(p)) {
        return ECPoint(qx, qy, U256_ONE);
    }

    let z1z1 = mod_sqr(p.z);
    let u2 = mod_mul(qx, z1z1);
    let s2 = mod_mul(qy, mod_mul(p.z, z1z1));

    let h = mod_sub(u2, p.x);

    // If h == 0, points have same x. Either doubling or point at infinity.
    if (u256_eq(h, U256_ZERO)) {
        if (u256_eq(s2, p.y)) {
            return ec_double(p);
        }
        return ec_identity();
    }

    let hh = mod_sqr(h);
    let i = mod_dbl(mod_dbl(hh));
    let j = mod_mul(h, i);
    var r = mod_sub(s2, p.y);
    r = mod_dbl(r);
    let v = mod_mul(p.x, i);

    var x3 = mod_sqr(r);
    x3 = mod_sub(x3, j);
    x3 = mod_sub(x3, mod_dbl(v));

    var y3 = mod_sub(v, x3);
    y3 = mod_mul(r, y3);
    var t = mod_mul(p.y, j);
    t = mod_dbl(t);
    y3 = mod_sub(y3, t);

    var z3 = mod_add(p.z, h);
    z3 = mod_sqr(z3);
    z3 = mod_sub(z3, mod_sqr(p.z));
    z3 = mod_sub(z3, hh);

    return ECPoint(x3, y3, z3);
}

// Scalar multiplication: scalar × G (double-and-add, MSB to LSB)
fn ec_mul(scalar: array<u32, 8>) -> ECPoint {
    var result = ec_identity();

    // Find highest set bit
    var top_bit = -1i;
    for (var i = 7i; i >= 0i; i--) {
        if (scalar[i] != 0u) {
            var v = scalar[i];
            for (var k = 31i; k >= 0i; k--) {
                if (((v >> u32(k)) & 1u) == 1u) {
                    top_bit = i * 32i + k;
                    break;
                }
            }
            break;
        }
    }

    if (top_bit < 0i) { return result; }

    for (var bit = top_bit; bit >= 0i; bit--) {
        result = ec_double(result);
        let limb_idx = u32(bit) >> 5u;
        let bit_idx = u32(bit) & 31u;
        if (((scalar[limb_idx] >> bit_idx) & 1u) == 1u) {
            result = ec_add_mixed(result, GX, GY);
        }
    }

    return result;
}

fn swap_endian_u32(x: u32) -> u32 {
    return ((x & 0xFFu) << 24u) |
           ((x & 0xFF00u) << 8u) |
           ((x & 0xFF0000u) >> 8u) |
           ((x & 0xFF000000u) >> 24u);
}

// Convert Jacobian → affine, return 16 u32s (x‖y) in big-endian byte order
fn ec_to_affine(p: ECPoint) -> array<u32, 16> {
    let z_inv = mod_inv(p.z);
    let z_inv2 = mod_sqr(z_inv);
    let z_inv3 = mod_mul(z_inv2, z_inv);
    let ax = mod_mul(p.x, z_inv2);
    let ay = mod_mul(p.y, z_inv3);

    var result: array<u32, 16>;
    for (var i = 0u; i < 8u; i++) {
        result[7u - i] = swap_endian_u32(ax[i]);
        result[15u - i] = swap_endian_u32(ay[i]);
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Section 3: Keccak-256 (fresh implementation, using vec2<u32> as 64-bit lanes)
// ═══════════════════════════════════════════════════════════════════════

alias lane = vec2<u32>; // (low, high)

fn mk(low: u32, high: u32) -> lane { return vec2<u32>(low, high); }
fn xxor(a: lane, b: lane) -> lane { return vec2<u32>(a.x ^ b.x, a.y ^ b.y); }
fn aand(a: lane, b: lane) -> lane { return vec2<u32>(a.x & b.x, a.y & b.y); }
fn nnot(a: lane) -> lane { return vec2<u32>(~a.x, ~a.y); }

fn rol_lo(x: lane, n: u32) -> lane {
    return vec2<u32>((x.x << n) | (x.y >> (32u - n)), (x.y << n) | (x.x >> (32u - n)));
}

fn rol_hi(x: lane, n: u32) -> lane {
    let s = n - 32u;
    return vec2<u32>((x.y << s) | (x.x >> (32u - s)), (x.x << s) | (x.y >> (32u - s)));
}

fn keccak_theta(a: ptr<function, array<lane, 25>>) {
    var c: array<lane, 5>;
    c[0] = xxor(xxor(xxor(xxor((*a)[0], (*a)[5]), (*a)[10]), (*a)[15]), (*a)[20]);
    c[1] = xxor(xxor(xxor(xxor((*a)[1], (*a)[6]), (*a)[11]), (*a)[16]), (*a)[21]);
    c[2] = xxor(xxor(xxor(xxor((*a)[2], (*a)[7]), (*a)[12]), (*a)[17]), (*a)[22]);
    c[3] = xxor(xxor(xxor(xxor((*a)[3], (*a)[8]), (*a)[13]), (*a)[18]), (*a)[23]);
    c[4] = xxor(xxor(xxor(xxor((*a)[4], (*a)[9]), (*a)[14]), (*a)[19]), (*a)[24]);
    var d: lane;
    d=xxor(c[4],rol_lo(c[1],1u)); (*a)[0]=xxor((*a)[0],d); (*a)[5]=xxor((*a)[5],d); (*a)[10]=xxor((*a)[10],d); (*a)[15]=xxor((*a)[15],d); (*a)[20]=xxor((*a)[20],d);
    d=xxor(c[0],rol_lo(c[2],1u)); (*a)[1]=xxor((*a)[1],d); (*a)[6]=xxor((*a)[6],d); (*a)[11]=xxor((*a)[11],d); (*a)[16]=xxor((*a)[16],d); (*a)[21]=xxor((*a)[21],d);
    d=xxor(c[1],rol_lo(c[3],1u)); (*a)[2]=xxor((*a)[2],d); (*a)[7]=xxor((*a)[7],d); (*a)[12]=xxor((*a)[12],d); (*a)[17]=xxor((*a)[17],d); (*a)[22]=xxor((*a)[22],d);
    d=xxor(c[2],rol_lo(c[4],1u)); (*a)[3]=xxor((*a)[3],d); (*a)[8]=xxor((*a)[8],d); (*a)[13]=xxor((*a)[13],d); (*a)[18]=xxor((*a)[18],d); (*a)[23]=xxor((*a)[23],d);
    d=xxor(c[3],rol_lo(c[0],1u)); (*a)[4]=xxor((*a)[4],d); (*a)[9]=xxor((*a)[9],d); (*a)[14]=xxor((*a)[14],d); (*a)[19]=xxor((*a)[19],d); (*a)[24]=xxor((*a)[24],d);
}

fn keccak_rhoPi(a: ptr<function, array<lane, 25>>) {
    var t: lane; var b0: lane;
    t=(*a)[1]; b0=(*a)[10]; (*a)[10]=rol_lo(t,1u);
    t=b0; b0=(*a)[7]; (*a)[7]=rol_lo(t,3u);
    t=b0; b0=(*a)[11]; (*a)[11]=rol_lo(t,6u);
    t=b0; b0=(*a)[17]; (*a)[17]=rol_lo(t,10u);
    t=b0; b0=(*a)[18]; (*a)[18]=rol_lo(t,15u);
    t=b0; b0=(*a)[3]; (*a)[3]=rol_lo(t,21u);
    t=b0; b0=(*a)[5]; (*a)[5]=rol_lo(t,28u);
    t=b0; b0=(*a)[16]; (*a)[16]=rol_hi(t,36u);
    t=b0; b0=(*a)[8]; (*a)[8]=rol_hi(t,45u);
    t=b0; b0=(*a)[21]; (*a)[21]=rol_hi(t,55u);
    t=b0; b0=(*a)[24]; (*a)[24]=rol_lo(t,2u);
    t=b0; b0=(*a)[4]; (*a)[4]=rol_lo(t,14u);
    t=b0; b0=(*a)[15]; (*a)[15]=rol_lo(t,27u);
    t=b0; b0=(*a)[23]; (*a)[23]=rol_hi(t,41u);
    t=b0; b0=(*a)[19]; (*a)[19]=rol_hi(t,56u);
    t=b0; b0=(*a)[13]; (*a)[13]=rol_lo(t,8u);
    t=b0; b0=(*a)[12]; (*a)[12]=rol_lo(t,25u);
    t=b0; b0=(*a)[2]; (*a)[2]=rol_hi(t,43u);
    t=b0; b0=(*a)[20]; (*a)[20]=rol_hi(t,62u);
    t=b0; b0=(*a)[14]; (*a)[14]=rol_lo(t,18u);
    t=b0; b0=(*a)[22]; (*a)[22]=rol_hi(t,39u);
    t=b0; b0=(*a)[9]; (*a)[9]=rol_hi(t,61u);
    t=b0; b0=(*a)[6]; (*a)[6]=rol_lo(t,20u);
    t=b0; b0=(*a)[1]; (*a)[1]=rol_hi(t,44u);
}

fn keccak_chi(a: ptr<function, array<lane, 25>>) {
    var b: array<lane, 5>;
    b[0]=(*a)[0]; b[1]=(*a)[1]; b[2]=(*a)[2]; b[3]=(*a)[3]; b[4]=(*a)[4];
    (*a)[0]=xxor(b[0],aand(nnot(b[1]),b[2])); (*a)[1]=xxor(b[1],aand(nnot(b[2]),b[3])); (*a)[2]=xxor(b[2],aand(nnot(b[3]),b[4])); (*a)[3]=xxor(b[3],aand(nnot(b[4]),b[0])); (*a)[4]=xxor(b[4],aand(nnot(b[0]),b[1]));
    b[0]=(*a)[5]; b[1]=(*a)[6]; b[2]=(*a)[7]; b[3]=(*a)[8]; b[4]=(*a)[9];
    (*a)[5]=xxor(b[0],aand(nnot(b[1]),b[2])); (*a)[6]=xxor(b[1],aand(nnot(b[2]),b[3])); (*a)[7]=xxor(b[2],aand(nnot(b[3]),b[4])); (*a)[8]=xxor(b[3],aand(nnot(b[4]),b[0])); (*a)[9]=xxor(b[4],aand(nnot(b[0]),b[1]));
    b[0]=(*a)[10]; b[1]=(*a)[11]; b[2]=(*a)[12]; b[3]=(*a)[13]; b[4]=(*a)[14];
    (*a)[10]=xxor(b[0],aand(nnot(b[1]),b[2])); (*a)[11]=xxor(b[1],aand(nnot(b[2]),b[3])); (*a)[12]=xxor(b[2],aand(nnot(b[3]),b[4])); (*a)[13]=xxor(b[3],aand(nnot(b[4]),b[0])); (*a)[14]=xxor(b[4],aand(nnot(b[0]),b[1]));
    b[0]=(*a)[15]; b[1]=(*a)[16]; b[2]=(*a)[17]; b[3]=(*a)[18]; b[4]=(*a)[19];
    (*a)[15]=xxor(b[0],aand(nnot(b[1]),b[2])); (*a)[16]=xxor(b[1],aand(nnot(b[2]),b[3])); (*a)[17]=xxor(b[2],aand(nnot(b[3]),b[4])); (*a)[18]=xxor(b[3],aand(nnot(b[4]),b[0])); (*a)[19]=xxor(b[4],aand(nnot(b[0]),b[1]));
    b[0]=(*a)[20]; b[1]=(*a)[21]; b[2]=(*a)[22]; b[3]=(*a)[23]; b[4]=(*a)[24];
    (*a)[20]=xxor(b[0],aand(nnot(b[1]),b[2])); (*a)[21]=xxor(b[1],aand(nnot(b[2]),b[3])); (*a)[22]=xxor(b[2],aand(nnot(b[3]),b[4])); (*a)[23]=xxor(b[3],aand(nnot(b[4]),b[0])); (*a)[24]=xxor(b[4],aand(nnot(b[0]),b[1]));
}

fn keccak_iota(a: ptr<function, array<lane, 25>>, rc: lane) { (*a)[0] = xxor((*a)[0], rc); }

fn keccakf(a: ptr<function, array<lane, 25>>) {
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00000001u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008082u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x0000808au, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80008000u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x0000808bu, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80000001u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80008081u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008009u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x0000008au, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00000088u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80008009u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x8000000au, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x8000808bu, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x0000008bu, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008089u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008003u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008002u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00000080u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x0000800au, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x8000000au, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80008081u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x00008080u, 0x80000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80000001u, 0x00000000u));
    keccak_theta(a); keccak_rhoPi(a); keccak_chi(a); keccak_iota(a, mk(0x80008008u, 0x80000000u));
}

// Keccak-256 of 64-byte input (uncompressed public key x‖y, big-endian bytes)
fn keccak256_64_pubkey(input: array<u32, 16>) -> array<u32, 8> {
    var state: array<lane, 25>;
    for (var i = 0u; i < 25u; i++) { state[i] = mk(0u, 0u); }

    // Absorb 64 bytes. Input is big-endian u32s → swap to LE for Keccak lanes.
    for (var i = 0u; i < 8u; i++) {
        let lo = swap_endian_u32(input[i * 2u + 1u]);
        let hi = swap_endian_u32(input[i * 2u]);
        state[i] = mk(lo, hi);
    }

    // Keccak padding for 64-byte message (rate=136)
    state[8] = xxor(state[8], mk(0x01u, 0u));
    state[16] = xxor(state[16], mk(0u, 0x80000000u));

    keccakf(&state);

    var result: array<u32, 8>;
    for (var i = 0u; i < 4u; i++) {
        result[i * 2u] = state[i].x;
        result[i * 2u + 1u] = state[i].y;
    }
    return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Section 4: Buffers and Main Entry Point
//
// Optimization: CPU precomputes base_point = (base_key + offset) * G and
// a 3-level table of G multiples. Each GPU thread does at most 3 EC point
// additions from the table instead of a full 256-bit scalar multiply.
//
// Table layout (1104 affine points, 16 u32s each):
//   [0..63]      Table A: i*G              (i = local_invocation_id.x)
//   [64..1087]   Table B: (i*64)*G         (i = workgroup_id.x, 0..1023)
//   [1088..1103] Table C: (i*65536)*G      (i = workgroup_id.y, 0..15)
//
// thread_id = gid.x + gid.y * 65536
// public_key = base_point + A[gid.x & 63] + B[gid.x >> 6] + C[gid.y]
// private_key = base_scalar + thread_id
// ═══════════════════════════════════════════════════════════════════════

struct Params {
    base_x_lo: vec4<u32>,       // base point affine x, limbs 0-3
    base_x_hi: vec4<u32>,       // base point affine x, limbs 4-7
    base_y_lo: vec4<u32>,       // base point affine y, limbs 0-3
    base_y_hi: vec4<u32>,       // base point affine y, limbs 4-7
    base_scalar_lo: vec4<u32>,  // private key scalar, limbs 0-3
    base_scalar_hi: vec4<u32>,  // private key scalar, limbs 4-7
}

fn get_base_x() -> array<u32, 8> {
    var r: array<u32, 8>;
    r[0]=params.base_x_lo.x; r[1]=params.base_x_lo.y; r[2]=params.base_x_lo.z; r[3]=params.base_x_lo.w;
    r[4]=params.base_x_hi.x; r[5]=params.base_x_hi.y; r[6]=params.base_x_hi.z; r[7]=params.base_x_hi.w;
    return r;
}

fn get_base_y() -> array<u32, 8> {
    var r: array<u32, 8>;
    r[0]=params.base_y_lo.x; r[1]=params.base_y_lo.y; r[2]=params.base_y_lo.z; r[3]=params.base_y_lo.w;
    r[4]=params.base_y_hi.x; r[5]=params.base_y_hi.y; r[6]=params.base_y_hi.z; r[7]=params.base_y_hi.w;
    return r;
}

fn get_base_scalar() -> array<u32, 8> {
    var r: array<u32, 8>;
    r[0]=params.base_scalar_lo.x; r[1]=params.base_scalar_lo.y; r[2]=params.base_scalar_lo.z; r[3]=params.base_scalar_lo.w;
    r[4]=params.base_scalar_hi.x; r[5]=params.base_scalar_hi.y; r[6]=params.base_scalar_hi.z; r[7]=params.base_scalar_hi.w;
    return r;
}

struct Results {
    addr0: atomic<u32>,
    addr1: atomic<u32>,
    addr2: atomic<u32>,
    addr3: atomic<u32>,
    addr4: atomic<u32>,
    key0: atomic<u32>,
    key1: atomic<u32>,
    key2: atomic<u32>,
    key3: atomic<u32>,
    key4: atomic<u32>,
    key5: atomic<u32>,
    key6: atomic<u32>,
    key7: atomic<u32>,
    found: atomic<u32>,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read_write> results: Results;
@group(0) @binding(2) var<storage, read> ec_table: array<u32>;

// Load affine x from table at index idx
fn load_table_x(idx: u32) -> array<u32, 8> {
    var r: array<u32, 8>;
    let base = idx * 16u;
    r[0]=ec_table[base]; r[1]=ec_table[base+1u]; r[2]=ec_table[base+2u]; r[3]=ec_table[base+3u];
    r[4]=ec_table[base+4u]; r[5]=ec_table[base+5u]; r[6]=ec_table[base+6u]; r[7]=ec_table[base+7u];
    return r;
}

// Load affine y from table at index idx
fn load_table_y(idx: u32) -> array<u32, 8> {
    var r: array<u32, 8>;
    let base = idx * 16u + 8u;
    r[0]=ec_table[base]; r[1]=ec_table[base+1u]; r[2]=ec_table[base+2u]; r[3]=ec_table[base+3u];
    r[4]=ec_table[base+4u]; r[5]=ec_table[base+5u]; r[6]=ec_table[base+6u]; r[7]=ec_table[base+7u];
    return r;
}

fn addr_is_smaller(new_addr: array<u32, 5>, b0: u32, b1: u32, b2: u32, b3: u32, b4: u32) -> bool {
    let n0=swap_endian_u32(new_addr[0]); let n1=swap_endian_u32(new_addr[1]);
    let n2=swap_endian_u32(new_addr[2]); let n3=swap_endian_u32(new_addr[3]);
    let n4=swap_endian_u32(new_addr[4]);
    let a0=swap_endian_u32(b0); let a1=swap_endian_u32(b1);
    let a2=swap_endian_u32(b2); let a3=swap_endian_u32(b3);
    let a4=swap_endian_u32(b4);
    if (n0<a0) {return true;} if (n0>a0) {return false;}
    if (n1<a1) {return true;} if (n1>a1) {return false;}
    if (n2<a2) {return true;} if (n2>a2) {return false;}
    if (n3<a3) {return true;} if (n3>a3) {return false;}
    if (n4<a4) {return true;}
    return false;
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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    // Decompose thread ID for 3-level table lookup
    let a_idx = gid.x & 63u;        // local_invocation_id.x: 0..63
    let b_idx = gid.x >> 6u;        // workgroup_id.x: 0..1023
    let c_idx = gid.y;              // workgroup_id.y: 0..15
    let thread_id = gid.x + gid.y * 65536u;

    // Start with base_point (precomputed on CPU) in Jacobian coords
    var pt = ECPoint(get_base_x(), get_base_y(), U256_ONE);

    // Add table A entry (i*G for thread-local offset)
    if (a_idx != 0u) {
        pt = ec_add_mixed(pt, load_table_x(a_idx), load_table_y(a_idx));
    }

    // Add table B entry (i*64*G for workgroup x offset)
    if (b_idx != 0u) {
        let bi = 64u + b_idx;
        pt = ec_add_mixed(pt, load_table_x(bi), load_table_y(bi));
    }

    // Add table C entry (i*65536*G for workgroup y offset)
    if (c_idx != 0u) {
        let ci = 1088u + c_idx;
        pt = ec_add_mixed(pt, load_table_x(ci), load_table_y(ci));
    }

    // Convert to affine (one mod_inv per thread)
    let pub_affine = ec_to_affine(pt);
    let hash = keccak256_64_pubkey(pub_affine);

    // Address = last 20 bytes of 32-byte hash
    var addr: array<u32, 5>;
    addr[0] = hash[3];
    addr[1] = hash[4];
    addr[2] = hash[5];
    addr[3] = hash[6];
    addr[4] = hash[7];

    // Private key = base_scalar + thread_id
    var key = get_base_scalar();
    key = u256_add_u32(key, thread_id);

    let best0 = atomicLoad(&results.addr0);
    let best1 = atomicLoad(&results.addr1);
    let best2 = atomicLoad(&results.addr2);
    let best3 = atomicLoad(&results.addr3);
    let best4 = atomicLoad(&results.addr4);

    if (addr_is_smaller(addr, best0, best1, best2, best3, best4)) {
        atomicStore(&results.addr0, addr[0]);
        atomicStore(&results.addr1, addr[1]);
        atomicStore(&results.addr2, addr[2]);
        atomicStore(&results.addr3, addr[3]);
        atomicStore(&results.addr4, addr[4]);
        atomicStore(&results.key0, key[0]);
        atomicStore(&results.key1, key[1]);
        atomicStore(&results.key2, key[2]);
        atomicStore(&results.key3, key[3]);
        atomicStore(&results.key4, key[4]);
        atomicStore(&results.key5, key[5]);
        atomicStore(&results.key6, key[6]);
        atomicStore(&results.key7, key[7]);
        atomicStore(&results.found, 1u);
    }
}
