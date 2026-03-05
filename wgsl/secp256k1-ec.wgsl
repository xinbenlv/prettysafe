// secp256k1 EC point operations (Jacobian coordinates)
//
// Depends on: secp256k1-field.wgsl (must be concatenated before this file)
//
// Types:  ECPoint { x, y, z: array<u32, 8> } (Jacobian)
// Consts: GX, GY (generator point, affine)
// Ops:    ec_identity, ec_is_identity, ec_double, ec_add_mixed, ec_mul
//         ec_to_affine (Jacobian → 16 big-endian u32s for keccak input)

const GX = array<u32, 8>(
    0x16F81798u, 0x59F2815Bu, 0x2DCE28D9u, 0x029BFCDB,
    0xCE870B07u, 0x55A06295u, 0xF9DCBBACu, 0x79BE667Eu
);
const GY = array<u32, 8>(
    0xFB10D4B8u, 0x9C47D08Fu, 0xA6855419u, 0xFD17B448u,
    0x0E1108A8u, 0x5DA4FBFCu, 0x26A3C465u, 0x483ADA77u
);

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
    z3 = mod_sub(z3, z1z1);
    z3 = mod_sub(z3, hh);

    return ECPoint(x3, y3, z3);
}

// Scalar multiplication: scalar * G (double-and-add, MSB to LSB)
fn ec_mul(scalar: array<u32, 8>) -> ECPoint {
    var result = ec_identity();

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

// Convert Jacobian → affine, return 16 u32s (x||y) in big-endian byte order
fn ec_to_affine(p: ECPoint) -> array<u32, 16> {
    let z_inv = mod_inv(p.z);
    let z_inv2 = mod_sqr(z_inv);
    let z_inv3 = mod_mul(z_inv2, z_inv);
    let ax = mod_mul(p.x, z_inv2);
    let ay = mod_mul(p.y, z_inv3);

    var result: array<u32, 16>;
    for (var i = 0u; i < 8u; i++) {
        result[7u - i] = ax[i];
        result[15u - i] = ay[i];
    }
    return result;
}
