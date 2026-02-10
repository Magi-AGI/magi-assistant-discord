import { type Writable } from 'stream';
import { randomBytes } from 'crypto';

/**
 * Minimal OGG Opus muxer that writes raw Opus packets into OGG pages.
 *
 * Design goals:
 * - Frequent page flushes (every packet) so files are recoverable after crash
 * - Correct OGG page structure with CRC-32 checksums
 * - Proper ID header and comment header for Opus-in-OGG
 * - EOS page on finalize
 */
export class OggMuxer {
  private output: Writable;
  private serialNo: number;
  private pageSeqNo: number = 0;
  private granulePos: bigint = 0n;
  private samplesPerFrame: number = 960; // 20ms at 48kHz
  private finalized = false;

  constructor(output: Writable) {
    this.output = output;
    this.serialNo = randomBytes(4).readUInt32LE(0);

    // Write OGG headers (ID header + comment header)
    this.writeIdHeader();
    this.writeCommentHeader();
  }

  /** Write an Opus packet as an OGG page. One packet per page for frequent flushing. */
  writeOpusPacket(opusData: Buffer): void {
    if (this.finalized) return;
    this.granulePos += BigInt(this.samplesPerFrame);
    this.writePage(opusData, 0x00, this.granulePos);
  }

  /** Write the EOS page and mark as finalized. */
  finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    // Write an empty EOS page
    this.writePage(Buffer.alloc(0), 0x04, this.granulePos);
  }

  private writeIdHeader(): void {
    // OpusHead: https://tools.ietf.org/html/rfc7845#section-5.1
    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 8, 'ascii');
    head.writeUInt8(1, 8);           // Version
    head.writeUInt8(2, 9);           // Channel count (stereo for Discord)
    head.writeUInt16LE(3840, 10);    // Pre-skip (80ms at 48kHz)
    head.writeUInt32LE(48000, 12);   // Input sample rate
    head.writeInt16LE(0, 16);        // Output gain
    head.writeUInt8(0, 18);          // Channel mapping family

    // BOS (Beginning of Stream) flag
    this.writePage(head, 0x02, 0n);
  }

  private writeCommentHeader(): void {
    // OpusTags: https://tools.ietf.org/html/rfc7845#section-5.2
    const vendor = 'magi-assistant-discord';
    const vendorBuf = Buffer.from(vendor, 'utf-8');

    const comment = Buffer.alloc(8 + vendorBuf.length + 4);
    comment.write('OpusTags', 0, 8, 'ascii');
    comment.writeUInt32LE(vendorBuf.length, 8);
    vendorBuf.copy(comment, 12);
    comment.writeUInt32LE(0, 12 + vendorBuf.length); // No user comments

    this.writePage(comment, 0x00, 0n);
  }

  private writePage(data: Buffer, headerType: number, granulePos: bigint): void {
    // OGG page header: 27 bytes + segment table
    const segments = Math.max(1, Math.ceil(data.length / 255));
    const headerSize = 27 + segments;
    const header = Buffer.alloc(headerSize);

    // Capture pattern
    header.write('OggS', 0, 4, 'ascii');
    // Stream structure version
    header.writeUInt8(0, 4);
    // Header type flag
    header.writeUInt8(headerType, 5);
    // Granule position (64-bit)
    header.writeBigUInt64LE(granulePos, 6);
    // Serial number
    header.writeUInt32LE(this.serialNo, 14);
    // Page sequence number
    header.writeUInt32LE(this.pageSeqNo++, 18);
    // CRC checksum (placeholder, filled below)
    header.writeUInt32LE(0, 22);
    // Number of segments
    header.writeUInt8(segments, 26);

    // Segment table
    let remaining = data.length;
    for (let i = 0; i < segments; i++) {
      if (remaining >= 255) {
        header.writeUInt8(255, 27 + i);
        remaining -= 255;
      } else {
        header.writeUInt8(remaining, 27 + i);
        remaining = 0;
      }
    }

    // Calculate CRC-32 over header + data
    const crc = ogg_crc32(header, data);
    header.writeUInt32LE(crc, 22);

    this.output.write(header);
    if (data.length > 0) {
      this.output.write(data);
    }
  }
}

// --- OGG CRC-32 (polynomial 0x04C11DB7) ---

const CRC_TABLE = new Uint32Array(256);

(function initCrcTable() {
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x80000000) {
        crc = ((crc << 1) ^ 0x04C11DB7) >>> 0;
      } else {
        crc = (crc << 1) >>> 0;
      }
    }
    CRC_TABLE[i] = crc >>> 0;
  }
})();

function ogg_crc32(header: Buffer, data: Buffer): number {
  let crc = 0;
  for (let i = 0; i < header.length; i++) {
    crc = (CRC_TABLE[((crc >>> 24) ^ header[i]) & 0xff] ^ (crc << 8)) >>> 0;
  }
  for (let i = 0; i < data.length; i++) {
    crc = (CRC_TABLE[((crc >>> 24) ^ data[i]) & 0xff] ^ (crc << 8)) >>> 0;
  }
  return crc >>> 0;
}
