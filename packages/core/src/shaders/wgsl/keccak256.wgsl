// Keccak-256 hash function (FIPS 202 / SHA-3 permutation)
//
// 64-bit lanes as vec2<u32> (lo, hi) — pure 32-bit arithmetic.
// Entry point: keccak256_64(input: array<u32, 16>) -> array<u32, 8>
//   Hashes 64 bytes (e.g. uncompressed EC pubkey x||y in big-endian).
//
// Also provides swap_endian_u32 for byte-order conversion.

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

fn swap_endian_u32(x: u32) -> u32 {
    return ((x & 0xFFu) << 24u) |
           ((x & 0xFF00u) << 8u) |
           ((x & 0xFF0000u) >> 8u) |
           ((x & 0xFF000000u) >> 24u);
}

// Keccak-256 of 64-byte input (big-endian u32s, e.g. uncompressed pubkey x||y)
fn keccak256_64(input: array<u32, 16>) -> array<u32, 8> {
    var state: array<lane, 25>;
    for (var i = 0u; i < 25u; i++) { state[i] = mk(0u, 0u); }

    // Absorb 64 bytes. Input is big-endian u32s → swap to LE for Keccak lanes.
    // Lane j = bytes [8j..8j+7], lo = bytes [8j..8j+3] LE, hi = bytes [8j+4..8j+7] LE
    for (var i = 0u; i < 8u; i++) {
        let lo = swap_endian_u32(input[i * 2u]);
        let hi = swap_endian_u32(input[i * 2u + 1u]);
        state[i] = mk(lo, hi);
    }

    // Keccak padding for 64-byte message (rate=136 bytes = 17 lanes)
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
