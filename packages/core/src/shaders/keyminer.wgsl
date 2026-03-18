// GPU Shader: EVM Vanity Address Miner — Dispatch Logic
//
// This file is concatenated AFTER the module files:
//   wgsl/secp256k1-field.wgsl  (u256, mod arithmetic)
//   wgsl/keccak256.wgsl        (keccak-256 hash, swap_endian_u32)
//   wgsl/secp256k1-ec.wgsl     (EC point ops, ec_to_affine)
//
// Pipeline: base_point + table_lookup → affine → keccak256 → address[12:32]

// ═══════════════════════════════════════════════════════════════════════
// Buffers and Main Entry Point
//
// CPU precomputes base_point = (base_key + offset) * G and a 3-level
// table of G multiples. Each GPU thread does at most 3 EC point
// additions from the table instead of a full 256-bit scalar multiply.
//
// Table layout (1104 affine points, 16 u32s each):
//   [0..63]      Table A: i*G              (local_invocation_id.x)
//   [64..1087]   Table B: (i*64)*G         (workgroup_id.x, 0..1023)
//   [1088..1103] Table C: (i*65536)*G      (workgroup_id.y, 0..15)
//
// thread_id = gid.x + gid.y * 65536
// public_key = base_point + A[gid.x & 63] + B[gid.x >> 6] + C[gid.y]
// private_key = base_scalar + thread_id
// ═══════════════════════════════════════════════════════════════════════

struct Params {
    base_x_lo: vec4<u32>,
    base_x_hi: vec4<u32>,
    base_y_lo: vec4<u32>,
    base_y_hi: vec4<u32>,
    base_scalar_lo: vec4<u32>,
    base_scalar_hi: vec4<u32>,
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
@group(0) @binding(3) var<storage, read_write> debug_buf: array<u32>;

fn load_table_x(idx: u32) -> array<u32, 8> {
    var r: array<u32, 8>;
    let base = idx * 16u;
    r[0]=ec_table[base]; r[1]=ec_table[base+1u]; r[2]=ec_table[base+2u]; r[3]=ec_table[base+3u];
    r[4]=ec_table[base+4u]; r[5]=ec_table[base+5u]; r[6]=ec_table[base+6u]; r[7]=ec_table[base+7u];
    return r;
}

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

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
    let a_idx = gid.x & 63u;
    let b_idx = gid.x >> 6u;
    let c_idx = gid.y;
    let thread_id = gid.x + gid.y * 65536u;

    var pt = ECPoint(get_base_x(), get_base_y(), U256_ONE);

    if (a_idx != 0u) {
        pt = ec_add_mixed(pt, load_table_x(a_idx), load_table_y(a_idx));
    }

    if (b_idx != 0u) {
        let bi = 64u + b_idx;
        pt = ec_add_mixed(pt, load_table_x(bi), load_table_y(bi));
    }

    if (c_idx != 0u) {
        let ci = 1088u + c_idx;
        pt = ec_add_mixed(pt, load_table_x(ci), load_table_y(ci));
    }

    let pub_affine = ec_to_affine(pt);
    let hash = keccak256_64(pub_affine);

    // Address = last 20 bytes of 32-byte hash
    var addr: array<u32, 5>;
    addr[0] = hash[3];
    addr[1] = hash[4];
    addr[2] = hash[5];
    addr[3] = hash[6];
    addr[4] = hash[7];

    var key = get_base_scalar();
    key = u256_add_u32(key, thread_id);

    // Thread 0 writes debug info: pubkey (16 u32s) + hash (8 u32s) + key (8 u32s) = 32 u32s
    if (thread_id == 0u) {
        for (var i = 0u; i < 16u; i++) { debug_buf[i] = pub_affine[i]; }
        for (var i = 0u; i < 8u; i++) { debug_buf[16u + i] = hash[i]; }
        for (var i = 0u; i < 8u; i++) { debug_buf[24u + i] = key[i]; }
    }

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
