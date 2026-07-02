// Minimal, dependency-free ZIP builder (store / no compression).
// Photos (JPEG/RAW) are already compressed, so "store" is the right method —
// it's fast, exact, and avoids pulling in a zip library. Not zip64: keep total
// archive size under 4 GB (fine for a keepers export).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8)
  }
  return (c ^ 0xFFFFFFFF) >>> 0
}

const u16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF]
const u32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF]

/**
 * Build a single .zip Blob from a list of entries.
 * @param {{name: string, blob: Blob}[]} entries
 * @returns {Promise<Blob>} application/zip
 */
export async function createZip(entries) {
  const enc = new TextEncoder()
  const chunks = []      // Uint8Array pieces assembled into the final Blob
  const central = []     // central-directory metadata per entry
  let offset = 0

  const push = (arr) => {
    const u = arr instanceof Uint8Array ? arr : new Uint8Array(arr)
    chunks.push(u)
    offset += u.length
  }

  for (const { name, blob } of entries) {
    const data = new Uint8Array(await blob.arrayBuffer())
    const nameBytes = enc.encode(name)
    const crc = crc32(data)
    const size = data.length
    const localOffset = offset

    // Local file header (bit 11 set = UTF-8 filename; method 0 = store)
    push([
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x0021),          // mod time / date (1980-01-01)
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ])
    push(nameBytes)
    push(data)

    central.push({ crc, size, nameBytes, localOffset })
  }

  const cdStart = offset
  for (const c of central) {
    push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0),
      ...u16(0), ...u16(0x0021),
      ...u32(c.crc), ...u32(c.size), ...u32(c.size),
      ...u16(c.nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0),
      ...u32(c.localOffset),
    ])
    push(c.nameBytes)
  }
  const cdSize = offset - cdStart

  // End of central directory
  push([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(central.length), ...u16(central.length),
    ...u32(cdSize), ...u32(cdStart), ...u16(0),
  ])

  return new Blob(chunks, { type: 'application/zip' })
}
