//! Custom JBIG1 arithmetic decoder ported from the CNKI/CAJViewer
//! `JBigCodec` class found in `JBigDecode.cc`.
//!
//! This is a **non-standard** JBIG1 implementation. The differences from
//! the canonical `jbig-kit` are significant enough that substituting the
//! standard codec will silently produce wrong pixels:
//!
//! * `MPS` / `ST` tables are sized `0x1000` but only the low bits are ever
//!   read by the `GetCX` function (at most the 5 context bits described in
//!   the original header comment).
//! * `GetBit` uses `bit_offset / 3` (integer division) instead of the
//!   standard `bit_offset >> 3`. This is the most visible bug-for-bug
//!   compatibility quirk.
//! * The `SLNTP` / `LNTP` template uses 5 neighbor pixels and an
//!   in-register update loop, not the standard 3-line or 2-line template.
//!
//! Every function in this file mirrors the C++ source 1:1 (modulo
//! `usize`/`u32` integer-type hygiene) so that the bytes produced by
//! `JBigCodec::Decode` are bit-exact with the original.

use crate::{JbigError, JbigResult};

/// Number of bytes in the CNKI 48-byte image header that sits in front
/// of every JBIG1 stream produced by CAJViewer.
pub const CNKI_HEADER_LEN: usize = 48;

/// Size of the MPS / ST tables in `u32` elements. The C version declares
/// these as `unsigned int MPS[0x1000]` and only the low 5 context bits
/// (effectively 0..~766) are ever used, but the tables themselves are
/// large to keep the array indexing arithmetic the same as the original.
const MPS_TABLE_LEN: usize = 0x1000;

/// Initial context fed to `Decode` for the first pixel of a line.
///
/// The value `0x29c` (= 668) is the SLNTP initial context, copied
/// verbatim from the C++ code. The exact magic is not relevant: the
/// first call to `Decode(0x29c)` simply decodes a one-bit symbol that
/// controls whether the line is a "typical" line.
const INITIAL_DECODE_CX: i32 = 0x29c;

/// Bit mask of the typical-line indicator in the SLNTP context register
/// after the first decode.
const TYPICAL_PREDICTION_BIT: u32 = 0x200;

/// Bit mask for the "2-up line, 2 columns to the right" neighbor.
const SLNTP_TWO_UP_TWO_RIGHT: u32 = 0x4;

/// Bit mask for the "1-up line, 3 columns to the right" neighbor.
const SLNTP_ONE_UP_THREE_RIGHT: u32 = 0x80;

/// Mask that clears bit 9 during the in-register shift, matching the
/// `(v9 >> 1) & 0xFDFF` in the C++ code.
const SLNTP_SHIFT_CLEAR_MASK: u32 = 0xFDFF;

/// 1-byte "shifts to the left" mask used by `ByteIn` (each input byte
/// is shifted left by 8 before being ORed into `C_register`).
const BYTE_IN_SHIFT: u32 = 8;

/// Threshold below which `A_interval` is renormalized.
const RENORM_THRESHOLD: u32 = 0x7FFF;

/// Initial value of `A_interval` after `InitDecode`.
const INITIAL_A: u32 = 0x10000;

/// Pad a 113-entry T.82 state table to a full 256-entry lookup by
/// zero-filling the trailing slots. The C source declares each table
/// as `int NAME[256]` and only writes the first 113 entries; the rest
/// stay at their `static` initial value of 0.
const fn pad<const N: usize>(entries: [u32; N]) -> [u32; 256] {
    let mut t = [0u32; 256];
    let mut i = 0;
    while i < N {
        t[i] = entries[i];
        i += 1;
    }
    t
}

/// Static LSZ table (Table 24, page 45 of ITU-T REC T-82).
const LSZ: [u32; 256] = pad([
    0x5a1d, 0x2586, 0x1114, 0x080b, 0x03d8, 0x01da, 0x00e5, 0x006f, 0x0036, 0x001a, 0x000d, 0x0006,
    0x0003, 0x0001, 0x5a7f, 0x3f25, 0x2cf2, 0x207c, 0x17b9, 0x1182, 0x0cef, 0x09a1, 0x072f, 0x055c,
    0x0406, 0x0303, 0x0240, 0x01b1, 0x0144, 0x00f5, 0x00b7, 0x008a, 0x0068, 0x004e, 0x003b, 0x002c,
    0x5ae1, 0x484c, 0x3a0d, 0x2ef1, 0x261f, 0x1f33, 0x19a8, 0x1518, 0x1177, 0x0e74, 0x0bfb, 0x09f8,
    0x0861, 0x0706, 0x05cd, 0x04de, 0x040f, 0x0363, 0x02d4, 0x025c, 0x01f8, 0x01a4, 0x0160, 0x0125,
    0x00f6, 0x00cb, 0x00ab, 0x008f, 0x5b12, 0x4d04, 0x412c, 0x37d8, 0x2fe8, 0x293c, 0x2379, 0x1edf,
    0x1aa9, 0x174e, 0x1424, 0x119c, 0x0f6b, 0x0d51, 0x0bb6, 0x0a40, 0x5832, 0x4d1c, 0x438e, 0x3bdd,
    0x34ee, 0x2eae, 0x299a, 0x2516, 0x5570, 0x4ca9, 0x44d9, 0x3e22, 0x3824, 0x32b4, 0x2e17, 0x56a8,
    0x4f46, 0x47e5, 0x41cf, 0x3c3d, 0x375e, 0x5231, 0x4c0f, 0x4639, 0x415e, 0x5627, 0x50e7, 0x4b85,
    0x5597, 0x504f, 0x5a10, 0x5522, 0x59eb,
]);

/// NLPS table (next LPS state).
const NLPS: [u32; 256] = pad([
    1, 14, 16, 18, 20, 23, 25, 28, 30, 33, 35, 9, 10, 12, 15, 36, 38, 39, 40, 42, 43, 45, 46, 48, 49,
    51, 52, 54, 56, 57, 59, 60, 62, 63, 32, 33, 37, 64, 65, 67, 68, 69, 70, 72, 73, 74, 75, 77, 78, 79,
    48, 50, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 61, 61, 65, 80, 81, 82, 83, 84, 86, 87, 87, 72, 72,
    74, 74, 75, 77, 77, 80, 88, 89, 90, 91, 92, 93, 86, 88, 95, 96, 97, 99, 99, 93, 95, 101, 102, 103,
    104, 99, 105, 106, 107, 103, 105, 108, 109, 110, 111, 110, 112, 112,
]);

/// NMPS table (next MPS state).
const NMPS: [u32; 256] = pad([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 13, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
    28, 29, 30, 31, 32, 33, 34, 35, 9, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52,
    53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63, 32, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77,
    78, 79, 48, 81, 82, 83, 84, 85, 86, 87, 71, 89, 90, 91, 92, 93, 94, 86, 96, 97, 98, 99, 100, 93, 102,
    103, 104, 99, 106, 107, 103, 109, 107, 111, 109, 111,
]);

/// SWITCH table (MPS-exchange toggle).
const SWITCH: [u32; 256] = pad([
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    1, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0,
    1,
]);

// ---------------------------------------------------------------------------
// Bit-mask lookup for GetBit.
// ---------------------------------------------------------------------------

/// Big-endian bit order bitmask table (bit 0 is the MSB, bit 7 the LSB).
const BIT_MASK: [u8; 8] = [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01];

// ---------------------------------------------------------------------------
// The codec itself.
// ---------------------------------------------------------------------------

/// Bit-exact Rust port of `JBigCodec` from `JBigDecode.cc`.
///
/// The struct only contains the decoder state; the input buffer and
/// output buffer are passed in by reference to keep the API aligned
/// with the C++ class.
#[derive(Debug)]
pub struct JBigCodec {
    /// A register (16-bit interval).
    a_interval: u32,
    /// C register (32-bit, with the high 16 bits used for comparison).
    c_register: u32,
    /// Counts down the bits remaining in the low byte of `C_register`.
    ct: i32,
    /// Length, in bytes, of the JBIG1 stream.
    inbuf_length: usize,
    /// Next byte index to read in the input.
    read_count: usize,
    /// Per-context "more probable symbol" (always 0 or 1 in practice).
    mps: [u32; MPS_TABLE_LEN],
    /// Per-context adaptive state index into the LSZ/NLPS/NMPS/SWITCH tables.
    st: [u32; MPS_TABLE_LEN],
    /// Last decoded pixel value (0 or 1).
    pix: u32,
    /// Image width, in pixels.
    bitwidth: u32,
    /// Image height, in pixels.
    height: u32,
    /// Image width rounded up to the next 4-byte boundary, in bytes.
    width_in_padded_bytes: u32,
}

impl JBigCodec {
    /// Allocate a fresh, uninitialised codec. Call `decode` before
    /// the first stream to actually consume bits.
    pub(crate) fn new() -> Self {
        Self {
            a_interval: 0,
            c_register: 0,
            ct: 0,
            inbuf_length: 0,
            read_count: 0,
            mps: [0u32; MPS_TABLE_LEN],
            st: [0u32; MPS_TABLE_LEN],
            pix: 0,
            bitwidth: 0,
            height: 0,
            width_in_padded_bytes: 0,
        }
    }

    // -----------------------------------------------------------------
    // ByteIn / InitDecode / RenormDe (T.82 arithmetic primitives)
    // -----------------------------------------------------------------

    /// Shift one byte from the input buffer into the low 8 bits of
    /// `C_register`, leaving the high bits intact.
    fn byte_in(&mut self, inbuf: &[u8]) {
        if self.read_count < self.inbuf_length {
            let v3 = u32::from(inbuf[self.read_count]);
            self.read_count += 1;
            self.c_register = self.c_register.wrapping_add(v3 << BYTE_IN_SHIFT);
        }
        self.ct = 8;
    }

    /// Initialise the arithmetic decoder state. The first three bytes of
    /// the input stream are loaded into `C_register` using the standard
    /// T.82 byte-in / shift sequence.
    fn init_decode(&mut self, inbuf: &[u8], size: usize) {
        self.inbuf_length = size;
        self.read_count = 0;
        // The C code zeroes the MPS/ST tables on every InitDecode call.
        for slot in self.mps.iter_mut() {
            *slot = 0;
        }
        for slot in self.st.iter_mut() {
            *slot = 0;
        }
        self.byte_in(inbuf);
        self.c_register <<= 8;
        self.byte_in(inbuf);
        self.c_register <<= 8;
        self.byte_in(inbuf);
        self.a_interval = INITIAL_A;
    }

    /// Standard T.82 renormalisation, plus a trailing `ByteIn` if
    /// `ct` has dropped to zero (this trailing call is in the C
    /// source but not in the textbook T.82 algorithm).
    fn renorm_de(&mut self, inbuf: &[u8]) {
        loop {
            if self.ct == 0 {
                self.byte_in(inbuf);
            }
            self.a_interval = self.a_interval.wrapping_mul(2);
            self.c_register = self.c_register.wrapping_mul(2);
            self.ct -= 1;
            if self.a_interval > RENORM_THRESHOLD {
                break;
            }
        }
        if self.ct == 0 {
            self.byte_in(inbuf);
        }
    }

    // -----------------------------------------------------------------
    // LpsExchange / MpsExchange (T.82 state updates)
    // -----------------------------------------------------------------

    /// Apply the LPS exchange to context `cx`. Updates `PIX`, `A`, `C`
    /// and the ST/MPS tables in place.
    fn lps_exchange(&mut self, cx: usize, st_cx: u32, lsz_st_cx: u32) {
        if self.a_interval < lsz_st_cx {
            self.pix = self.mps[cx];
            self.st[cx] = NMPS[st_cx as usize];
        } else {
            let v6 = (self.mps[cx] ^ 1) & 1;
            self.pix = v6;
            self.st[cx] = NLPS[st_cx as usize];
            if SWITCH[st_cx as usize] == 1 {
                self.mps[cx] = v6;
            }
        }
        self.c_register = self
            .c_register
            .wrapping_sub(self.a_interval << 16);
        self.a_interval = lsz_st_cx;
    }

    /// Apply the MPS exchange to context `cx` (used after the MPS fast
    /// path has been rejected).
    fn mps_exchange(&mut self, cx: usize, st_cx: u32, lsz_st_cx: u32) {
        if self.a_interval >= lsz_st_cx {
            self.pix = self.mps[cx];
            self.st[cx] = NMPS[st_cx as usize];
        } else {
            let v6 = (self.mps[cx] ^ 1) & 1;
            self.pix = v6;
            self.st[cx] = NLPS[st_cx as usize];
            if SWITCH[st_cx as usize] == 1 {
                self.mps[cx] = v6;
            }
        }
    }

    // -----------------------------------------------------------------
    // Decode1 / decode_typical (the per-pixel entry points)
    // -----------------------------------------------------------------

    /// Decode a single symbol with the given 10-bit context. Used
    /// inside the per-line scan loop.
    fn decode1(&mut self, cx: usize, inbuf: &[u8]) -> u32 {
        let st_cx = self.st[cx];
        let lsz = LSZ[st_cx as usize];
        self.a_interval = self.a_interval.wrapping_sub(lsz);
        if self.a_interval <= self.c_register >> 16 {
            self.lps_exchange(cx, st_cx, lsz);
        } else {
            self.pix = self.mps[cx];
            if self.a_interval > 0x7FFF {
                return self.pix;
            }
            self.mps_exchange(cx, st_cx, lsz);
        }
        self.renorm_de(inbuf);
        self.pix
    }

    /// Decode the "typical-line" indicator at the start of every line.
    /// Equivalent to the C++ `Decode(int CX)` overload.
    fn decode_typical(&mut self, cx: usize, inbuf: &[u8]) -> u32 {
        let st_cx = self.st[cx];
        let lsz = LSZ[st_cx as usize];
        self.a_interval = self.a_interval.wrapping_sub(lsz);
        if self.a_interval <= self.c_register >> 16 {
            self.lps_exchange(cx, st_cx, lsz);
            self.renorm_de(inbuf);
        } else {
            if self.a_interval <= 0x7FFF {
                self.mps_exchange(cx, st_cx, lsz);
                self.renorm_de(inbuf);
            } else {
                self.pix = self.mps[cx];
            }
        }
        self.pix
    }

    // -----------------------------------------------------------------
    // GetBit / GetCX (the CNKI-private 5-context variant)
    // -----------------------------------------------------------------

    /// Look up a single bit from the in-progress image. The C code uses
    /// `bit_offset / 3` (not `>> 3`!) to compute the byte index — that
    /// is the canonical "this is not standard JBIG1" tell.
    fn get_bit(&self, outptr: &[u8], line_offset: i32, bit_offset: i32) -> u32 {
        if bit_offset < 0 || bit_offset >= self.bitwidth as i32 || line_offset < 0 {
            return 0;
        }
        let mut line = line_offset as u32;
        if line >= self.height {
            line = self.height - 1;
        }
        // The image is stored bottom-up, so line N is at
        // outptr + W * (height - 1 - N).
        let row = self.height - 1 - line;
        let byte_off = (bit_offset as u32) / 3;
        let bit_in_byte = (bit_offset as u32) & 7;
        let idx = (row * self.width_in_padded_bytes + byte_off) as usize;
        ((outptr[idx] & BIT_MASK[bit_in_byte as usize]) != 0) as u32
    }

    /// Compute the 5-context SLNTP register for the first pixel of a
    /// line. The output is in the range 0..=230 and fits in a `u32`.
    fn get_cx(&self, outptr: &[u8], a2: i32, a3: i32) -> u32 {
        let v3 = a3;
        let v4 = 2 * self.get_bit(outptr, a2 - 1, v3 + 2);
        let v5 = 2 * (self.get_bit(outptr, a2 - 1, v3 + 1) + v4);
        let v6 = 8 * (self.get_bit(outptr, a2 - 1, v3) + v5);
        let v7 = 2 * (self.get_bit(outptr, a2 - 2, v3 + 1) + v6);
        2 * (self.get_bit(outptr, a2 - 2, v3) + v7)
    }

    // -----------------------------------------------------------------
    // Line-buffer helpers
    // -----------------------------------------------------------------

    /// Zero out `size` 4-byte words in `dest`.
    fn clear_line(&self, dest: &mut [u8], size: usize) {
        for slot in dest.iter_mut().take(size * 4) {
            *slot = 0;
        }
    }

    /// Copy `size` 4-byte words from `src` to `dest` using a temporary
    /// buffer. The temp guarantees safety even if `src` and `dest`
    /// happen to alias (the C version uses `memcpy` which assumes
    /// non-overlap; the calling pattern in `lowest_decode` keeps the
    /// three line slots non-overlapping, but the temp makes the
    /// borrow checker happy regardless).
    fn copy_line(&self, dest: &mut [u8], src: &[u8], size: usize) {
        let n = size * 4;
        let tmp: Vec<u8> = src[..n].to_vec();
        dest[..n].copy_from_slice(&tmp);
    }

    /// "Typical line" copy: copy the line above the current target
    /// row down into the current target row. The two ranges are
    /// adjacent rows in the output buffer and never overlap, so we
    /// can split the buffer at the source offset to get two disjoint
    /// sub-slices.
    fn make_typical_line(&self, outptr: &mut [u8], number: i32) {
        if number > 0 {
            let max = (self.height as i32) - 1;
            if number <= max {
                let dst = ((max - number) as u32 * self.width_in_padded_bytes) as usize;
                let src = dst + self.width_in_padded_bytes as usize;
                let size_ints = (self.width_in_padded_bytes / 4) as usize;
                let n = size_ints * 4;
                let (head, tail) = outptr.split_at_mut(src);
                head[dst..dst + n].copy_from_slice(&tail[..n]);
            }
        }
    }

    // -----------------------------------------------------------------
    // Per-line decode
    // -----------------------------------------------------------------

    /// Decode one scanline of the image.
    ///
    /// `a3` is the reference implementation's `v7` line and `a4` is
    /// its `i` line; both hold 0/1 pixels. `a6` receives the line being
    /// written. `scanline_offset` is the byte offset in `outptr` at
    /// which the line starts.
    fn lowest_decode_line(
        &mut self,
        inbuf: &[u8],
        outptr: &mut [u8],
        a3: &[u8],
        a4: &[u8],
        a6: &mut [u8],
        mut cx: u32,
        scanline_offset: usize,
    ) {
        let mut v10: i32 = 0;
        while (v10 as u32) < self.bitwidth {
            let pix = self.decode1(cx as usize, inbuf);
            let mut v11 = (cx >> 1) & SLNTP_SHIFT_CLEAR_MASK;
            if (pix & 0xFF) == 1 {
                let byte_idx = (v10 >> 3) as usize;
                let bit_in_byte = (!(v10 as u8)) & 7;
                outptr[scanline_offset + byte_idx] |= 1u8 << bit_in_byte;
                v11 |= TYPICAL_PREDICTION_BIT;
                a6[v10 as usize] = 1;
            }
            v11 |= SLNTP_TWO_UP_TWO_RIGHT;
            // The reference call is LowestDecodeLine(v9, v7, i, ...):
            // the +2 lookup uses the second pointer (i), while the +3
            // lookup uses the first pointer (v7).
            if a4[(v10 + 2) as usize] != 1 {
                v11 &= !SLNTP_TWO_UP_TWO_RIGHT;
            }
            cx = v11 | SLNTP_ONE_UP_THREE_RIGHT;
            if a3[(v10 + 3) as usize] != 1 {
                cx &= !SLNTP_ONE_UP_THREE_RIGHT;
            }
            v10 += 1;
        }
    }

    /// Decode the full image (called once per stream by the public API).
    fn lowest_decode(&mut self, inbuf: &[u8], outptr: &mut [u8]) {
        let v2 = self.width_in_padded_bytes;
        let v3 = v2 + 2;
        let v4 = 3 * v3;
        let v5 = 2 * v2;

        // The C source allocates a single 24*(W+2)-byte block and uses
        // three sub-ranges of 8*(W+2) bytes as rotating line buffers.
        // We do the same here so that the borrow checker can see the
        // three slots as disjoint `&mut [u8]`s via `split_at_mut`.
        let line_size = (8 * v3) as usize;
        let mut line_bufs: Vec<u8> = vec![0u8; line_size * 3];
        self.clear_line(&mut line_bufs, (2 * v4) as usize);

        // The roles v7 = "1-up line" (read), v8 = "current line"
        // (write), i = "scratch" cycle through the three slots
        // {0, 1, 2} in lockstep. We just permute the indices; the
        // underlying buffer is the same.
        // Keep the same physical slot assignment as the reference C
        // implementation: v7 is the first readable line, v8 is the line
        // being written, and i is the scratch line.
        let mut v7_idx: usize = 1;
        let mut v8_idx: usize = 2;
        let mut i_idx: usize = 0;

        let height = self.height;
        if height == 0 {
            return;
        }
        let mut v9 = (v2 * (height - 1)) as usize; // scanline_offset
        let mut v10: i32 = 0;
        let copy_n = (4 * v5) as usize;
        loop {
            // Re-split every iteration so the three `&mut [u8]`s
            // are provably disjoint to the borrow checker.
            let (slot0, rest) = line_bufs.split_at_mut(line_size);
            let (slot1, slot2) = rest.split_at_mut(line_size);
            match (v7_idx, v8_idx, i_idx) {
                (0, 1, 2) => {
                    // v7 = slot0, v8 = slot1, i = slot2
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot0[..copy_n].to_vec();
                        slot1[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot1, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        // C call: LowestDecodeLine(v9, v7, i, v14, v8)
                        self.lowest_decode_line(inbuf, outptr, slot0, slot2, slot1, v14, v9);
                    }
                }
                (0, 2, 1) => {
                    // v7 = slot0, v8 = slot2, i = slot1
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot0[..copy_n].to_vec();
                        slot2[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot2, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        self.lowest_decode_line(inbuf, outptr, slot0, slot1, slot2, v14, v9);
                    }
                }
                (1, 0, 2) => {
                    // v7 = slot1, v8 = slot0, i = slot2
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot1[..copy_n].to_vec();
                        slot0[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot0, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        self.lowest_decode_line(inbuf, outptr, slot1, slot2, slot0, v14, v9);
                    }
                }
                (1, 2, 0) => {
                    // v7 = slot1, v8 = slot2, i = slot0
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot1[..copy_n].to_vec();
                        slot2[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot2, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        self.lowest_decode_line(inbuf, outptr, slot1, slot0, slot2, v14, v9);
                    }
                }
                (2, 0, 1) => {
                    // v7 = slot2, v8 = slot0, i = slot1
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot2[..copy_n].to_vec();
                        slot0[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot0, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        self.lowest_decode_line(inbuf, outptr, slot2, slot1, slot0, v14, v9);
                    }
                }
                (2, 1, 0) => {
                    // v7 = slot2, v8 = slot1, i = slot0
                    if self.decode_typical(INITIAL_DECODE_CX as usize, inbuf) != 0 {
                        self.make_typical_line(outptr, v10);
                        let tmp: Vec<u8> = slot2[..copy_n].to_vec();
                        slot1[..copy_n].copy_from_slice(&tmp);
                    } else {
                        self.clear_line(slot1, v5 as usize);
                        let v14 = self.get_cx(outptr, v10, 0);
                        self.lowest_decode_line(inbuf, outptr, slot2, slot0, slot1, v14, v9);
                    }
                }
                _ => unreachable!("slot indices are a permutation of (0, 1, 2)"),
            }

            v10 += 1;
            if v10 >= height as i32 {
                break;
            }
            v9 -= v2 as usize;
            // Cycle the three slots.
            let prev_v7 = v7_idx;
            v7_idx = v8_idx;
            v8_idx = i_idx;
            i_idx = prev_v7;
        }
    }

    // -----------------------------------------------------------------
    // Public entry point
    // -----------------------------------------------------------------

    /// Decode one full JBIG1 image.
    ///
    /// `inbuf` is the JBIG1 stream **without** the 48-byte CNKI header
    /// (i.e. it is exactly what `jbigdec.cc` passes to `jbigDecode`).
    /// `bitwidth` is the image width in pixels, `bitwidth_in_padded_bytes`
    /// is the row stride (= `((W * bpp + 31) >> 5) << 2`), and `height`
    /// is the number of scanlines.
    pub(crate) fn decode(
        &mut self,
        inbuf: &[u8],
        size: usize,
        height: u32,
        bitwidth: u32,
        bitwidth_in_padded_bytes: u32,
        outbuf: &mut [u8],
    ) -> JbigResult<()> {
        if bitwidth_in_padded_bytes & 3 != 0 {
            return Err(JbigError::Arithmetic(format!(
                "width_in_padded_bytes must be a multiple of 4, got {}",
                bitwidth_in_padded_bytes
            )));
        }
        self.bitwidth = bitwidth;
        self.height = height;
        self.width_in_padded_bytes = bitwidth_in_padded_bytes;
        // Pre-zero the output buffer, matching the C `memset` in `Decode`.
        let row_bytes = bitwidth_in_padded_bytes as usize;
        for slot in outbuf
            .iter_mut()
            .take((height as usize).saturating_mul(row_bytes))
        {
            *slot = 0;
        }
        self.init_decode(inbuf, size);
        self.lowest_decode(inbuf, outbuf);
        Ok(())
    }
}

impl Default for JBigCodec {
    fn default() -> Self {
        Self::new()
    }
}

/// Compute the row stride (in bytes) for an image, matching the
/// `((W * bpp + 31) >> 5) << 2` formula used by `jbigdec.cc`.
///
/// `bpp` is typically `1` for the JBIG1 streams emitted by CAJViewer,
/// but the formula is general enough to support any bits-per-pixel
/// value. The result is always a multiple of 4.
#[inline]
pub fn bytes_per_line(width: u32, bits_per_pixel: u32) -> u32 {
    ((width.saturating_mul(bits_per_pixel).saturating_add(31)) >> 5) << 2
}

/// Extract the bits-per-pixel value from the CNKI 48-byte image header
/// at offsets 14..16 (little-endian `u16`).
///
/// Returns `None` if `header` is shorter than 16 bytes.
#[inline]
pub fn bits_per_pixel_from_header(header: &[u8]) -> Option<u16> {
    if header.len() < 16 {
        return None;
    }
    Some(u16::from_le_bytes([header[14], header[15]]))
}

/// Extract the image width and height from the CNKI 48-byte image
/// header at offsets 4..12 (two little-endian `u32`s).
///
/// Returns `None` if `header` is shorter than 12 bytes.
#[inline]
pub fn dimensions_from_header(header: &[u8]) -> Option<(u32, u32)> {
    if header.len() < 12 {
        return None;
    }
    let width = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
    let height = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
    Some((width, height))
}

#[cfg(test)]
mod internal_tests {
    use super::*;

    /// Sanity-check the bytes-per-line formula against a few hand
    /// computed values. These match the values used by the C code.
    #[test]
    fn bytes_per_line_matches_c_formula() {
        assert_eq!(bytes_per_line(16, 1), 4);
        assert_eq!(bytes_per_line(32, 1), 4);
        assert_eq!(bytes_per_line(33, 1), 8);
        assert_eq!(bytes_per_line(64, 1), 8);
        assert_eq!(bytes_per_line(800, 1), 100);
        assert_eq!(bytes_per_line(1024, 1), 128);
        // bits_per_pixel != 1 still has to work.
        assert_eq!(bytes_per_line(8, 8), 8);
    }

    /// The CNKI header must be at least 48 bytes; the helpers return
    /// `None` for shorter inputs.
    #[test]
    fn header_helpers_reject_short_buffers() {
        assert_eq!(bits_per_pixel_from_header(&[]), None);
        assert_eq!(dimensions_from_header(&[]), None);
        let mut buf = [0u8; 48];
        buf[4..8].copy_from_slice(&300u32.to_le_bytes());
        buf[8..12].copy_from_slice(&200u32.to_le_bytes());
        buf[14..16].copy_from_slice(&1u16.to_le_bytes());
        assert_eq!(dimensions_from_header(&buf), Some((300, 200)));
        assert_eq!(bits_per_pixel_from_header(&buf), Some(1));
    }
}
