/* ── MD5 (RFC 1321) ────────────────────────────────────────────────────
 *
 * `ring` deliberately carries no MD5 — it is a modern-primitives library
 * and MD5 is broken for every security purpose. Node's `crypto` carries
 * it anyway, and so must this runtime: the published ecosystem hashes
 * ETags, cache keys and content fingerprints with it, so an island that
 * cannot answer `createHash("md5")` cannot run npm code. This is the
 * whole reason the digest is spelled out here instead of pulled in: the
 * runtime takes no new dependency for a legacy checksum.
 *
 * The C runtime already spells the same digest out in `scr_lib.c`
 * (`scr_md5_digest`) — that file is the semantic reference this one is
 * matched against, so the two lanes agree byte for byte.
 *
 * MD5 is a checksum here, never a security primitive: nothing in this
 * file is constant time, and callers must not use it for authentication.
 * (`md5_hmac` exists because Node's `createHmac("md5", …)` exists, not
 * because HMAC-MD5 is advisable.)
 */

/// The 64 round constants, `floor(2^32 · |sin(i + 1)|)` for `i` in 0..64
/// (RFC 1321 §3.4).
const MD5_K: [u32; 64] = [
    0xd76a_a478, 0xe8c7_b756, 0x2420_70db, 0xc1bd_ceee, 0xf57c_0faf, 0x4787_c62a,
    0xa830_4613, 0xfd46_9501, 0x6980_98d8, 0x8b44_f7af, 0xffff_5bb1, 0x895c_d7be,
    0x6b90_1122, 0xfd98_7193, 0xa679_438e, 0x49b4_0821, 0xf61e_2562, 0xc040_b340,
    0x265e_5a51, 0xe9b6_c7aa, 0xd62f_105d, 0x0244_1453, 0xd8a1_e681, 0xe7d3_fbc8,
    0x21e1_cde6, 0xc337_07d6, 0xf4d5_0d87, 0x455a_14ed, 0xa9e3_e905, 0xfcef_a3f8,
    0x676f_02d9, 0x8d2a_4c8a, 0xfffa_3942, 0x8771_f681, 0x6d9d_6122, 0xfde5_380c,
    0xa4be_ea44, 0x4bde_cfa9, 0xf6bb_4b60, 0xbebf_bc70, 0x289b_7ec6, 0xeaa1_27fa,
    0xd4ef_3085, 0x0488_1d05, 0xd9d4_d039, 0xe6db_99e5, 0x1fa2_7cf8, 0xc4ac_5665,
    0xf429_2244, 0x432a_ff97, 0xab94_23a7, 0xfc93_a039, 0x655b_59c3, 0x8f0c_cc92,
    0xffef_f47d, 0x8584_5dd1, 0x6fa8_7e4f, 0xfe2c_e6e0, 0xa301_4314, 0x4e08_11a1,
    0xf753_7e82, 0xbd3a_f235, 0x2ad7_d2bb, 0xeb86_d391,
];

/// The per-round left-rotation amounts (RFC 1321 §3.4), four repeating
/// quadruples, one group of sixteen per round function.
const MD5_R: [u32; 64] = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

/// The MD5 initial state (RFC 1321 §3.3), little-endian words.
const MD5_INITIAL_STATE: [u32; 4] = [0x6745_2301, 0xefcd_ab89, 0x98ba_dcfe, 0x1032_5476];

/// The size of one MD5 block, and the HMAC block size that goes with it.
const MD5_BLOCK: usize = 64;

/// One 64-byte compression, folded into `state`.
///
/// Every add wraps — MD5 is defined mod 2^32 — and the message words are
/// LITTLE-endian, which is the one place MD5 differs in shape from the
/// SHA family sitting beside it in the C runtime.
fn md5_block(state: &mut [u32; 4], block: &[u8; MD5_BLOCK]) {
    let mut message = [0u32; 16];
    for (word, chunk) in message.iter_mut().zip(block.as_chunks::<4>().0) {
        *word = u32::from_le_bytes(*chunk);
    }

    let [mut a, mut b, mut c, mut d] = *state;
    for (round, (&constant, &rotation)) in MD5_K.iter().zip(MD5_R.iter()).enumerate() {
        let (mixed, index) = match round / 16 {
            0 => ((b & c) | (!b & d), round),
            1 => ((d & b) | (!d & c), (5 * round + 1) % 16),
            2 => (b ^ c ^ d, (3 * round + 5) % 16),
            _ => (c ^ (b | !d), (7 * round) % 16),
        };
        let sum = a
            .wrapping_add(mixed)
            .wrapping_add(constant)
            .wrapping_add(message[index]);
        a = d;
        d = c;
        c = b;
        b = b.wrapping_add(sum.rotate_left(rotation));
    }

    state[0] = state[0].wrapping_add(a);
    state[1] = state[1].wrapping_add(b);
    state[2] = state[2].wrapping_add(c);
    state[3] = state[3].wrapping_add(d);
}

/// The MD5 digest of `data`, as its 16 raw bytes.
///
/// The padding is the RFC's: one `0x80` byte, zeroes, then the message
/// length in BITS as a little-endian u64. That tail needs either one or
/// two more blocks depending on how close the `0x80` lands to the length
/// field, which is why the scratch buffer is two blocks wide.
fn md5_digest(data: &[u8]) -> [u8; 16] {
    let mut state = MD5_INITIAL_STATE;
    let (blocks, remainder) = data.as_chunks::<MD5_BLOCK>();
    for block in blocks {
        md5_block(&mut state, block);
    }

    let mut tail = [0u8; MD5_BLOCK * 2];
    tail[..remainder.len()].copy_from_slice(remainder);
    tail[remainder.len()] = 0x80;
    let padded = if remainder.len() + 1 + 8 <= MD5_BLOCK { MD5_BLOCK } else { MD5_BLOCK * 2 };
    let bits = (data.len() as u64).wrapping_mul(8);
    tail[padded - 8..padded].copy_from_slice(&bits.to_le_bytes());
    for block in tail[..padded].as_chunks::<MD5_BLOCK>().0 {
        md5_block(&mut state, block);
    }

    let mut digest = [0u8; 16];
    for (out, word) in digest.as_chunks_mut::<4>().0.iter_mut().zip(state) {
        *out = word.to_le_bytes();
    }
    digest
}

/// HMAC-MD5 (RFC 2104) over a 64-byte block, as its 16 raw tag bytes.
///
/// `ring::hmac` has no MD5 algorithm to hand this to, so the construction
/// is spelled out too: a key longer than the block is replaced by its own
/// digest, a shorter one is zero-padded, and the tag is
/// `MD5(K^opad ‖ MD5(K^ipad ‖ data))`.
fn md5_hmac(key: &[u8], data: &[u8]) -> [u8; 16] {
    let mut block_key = [0u8; MD5_BLOCK];
    if key.len() > MD5_BLOCK {
        block_key[..16].copy_from_slice(&md5_digest(key));
    } else {
        block_key[..key.len()].copy_from_slice(key);
    }

    let mut inner = Vec::with_capacity(MD5_BLOCK + data.len());
    inner.extend(block_key.iter().map(|byte| byte ^ 0x36));
    inner.extend_from_slice(data);

    let mut outer = Vec::with_capacity(MD5_BLOCK + 16);
    outer.extend(block_key.iter().map(|byte| byte ^ 0x5c));
    outer.extend_from_slice(&md5_digest(&inner));
    md5_digest(&outer)
}
