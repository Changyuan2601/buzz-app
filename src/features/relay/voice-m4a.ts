/** Voice notes as audio-only AAC `.m4a`: the platform's WebCodecs encoder
 * produces AAC (no bundled codec), and this module packages it as a fast-start
 * MP4 with no metadata boxes, the shape the relay accepts as `audio/mp4`. */
const AAC = "mp4a.40.2";
const BITRATE = 64_000;
const FRAME_SAMPLES = 1024;
/** Prefer the recording's own rate; every AAC encoder takes 48 kHz. */
const FALLBACK_RATE = 48_000;
/** ISO/IEC 14496-3 sampling frequency index order. */
const AAC_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

/** Encode the recorder's WAV as `.m4a`, or `undefined` when this platform has
 * no usable AAC encoder. */
export async function encodeVoiceNoteM4a(
  file: File,
  signal: AbortSignal,
): Promise<File | undefined> {
  if (typeof AudioEncoder === "undefined" || typeof AudioData === "undefined")
    return undefined;
  const pcm = wavMono16(new Uint8Array(await file.arrayBuffer()));
  signal.throwIfAborted();
  if (!pcm) return undefined;
  let rate: number | undefined;
  for (const candidate of new Set([pcm.rate, FALLBACK_RATE])) {
    const supported = await AudioEncoder.isConfigSupported({
      codec: AAC,
      sampleRate: candidate,
      numberOfChannels: 1,
      bitrate: BITRATE,
    }).then(
      (support) => support.supported,
      () => false,
    );
    signal.throwIfAborted();
    if (supported && AAC_RATES.includes(candidate)) {
      rate = candidate;
      break;
    }
  }
  if (!rate) return undefined;
  const samples = resample(pcm.samples, pcm.rate, rate);
  const frames: Uint8Array[] = [];
  let failed = false;
  const encoder = new AudioEncoder({
    output(chunk) {
      const bytes = new Uint8Array(chunk.byteLength);
      chunk.copyTo(bytes);
      frames.push(bytes);
    },
    error() {
      failed = true;
    },
  });
  try {
    encoder.configure({
      codec: AAC,
      sampleRate: rate,
      numberOfChannels: 1,
      bitrate: BITRATE,
    });
    for (let offset = 0; offset < samples.length; offset += rate) {
      signal.throwIfAborted();
      const data = samples.subarray(offset, offset + rate);
      const audio = new AudioData({
        format: "f32-planar",
        sampleRate: rate,
        numberOfChannels: 1,
        numberOfFrames: data.length,
        timestamp: Math.round((offset * 1_000_000) / rate),
        data,
      });
      encoder.encode(audio);
      audio.close();
    }
    await encoder.flush();
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  } finally {
    if (encoder.state !== "closed") encoder.close();
  }
  signal.throwIfAborted();
  if (failed || !frames.length) return undefined;
  return new File(
    [muxM4a(frames, audioSpecificConfig(rate), rate)],
    file.name.replace(/\.wav$/i, ".m4a"),
    { type: "audio/mp4", lastModified: file.lastModified },
  );
}

/** The recorder's own WAV: PCM, mono, 16-bit. Anything else is not ours. */
function wavMono16(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (a: number) => String.fromCharCode(...bytes.subarray(a, a + 4));
  if (bytes.length < 12 || text(0) !== "RIFF" || text(8) !== "WAVE")
    return undefined;
  let rate = 0;
  for (let offset = 12; offset + 8 <= bytes.length; ) {
    const kind = text(offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) return undefined;
    if (kind === "fmt ") {
      if (
        size < 16 ||
        view.getUint16(body, true) !== 1 ||
        view.getUint16(body + 2, true) !== 1 ||
        view.getUint16(body + 14, true) !== 16
      )
        return undefined;
      rate = view.getUint32(body + 4, true);
    } else if (kind === "data") {
      if (!rate || size < 2) return undefined;
      const samples = new Float32Array(size >> 1);
      for (let index = 0; index < samples.length; index += 1)
        samples[index] = view.getInt16(body + index * 2, true) / 0x8000;
      return { rate, samples };
    }
    offset = body + size + (size & 1);
  }
  return undefined;
}

function resample(
  samples: Float32Array<ArrayBuffer>,
  from: number,
  to: number,
) {
  if (from === to) return samples;
  const output = new Float32Array(
    Math.max(1, Math.floor((samples.length * to) / from)),
  );
  for (let index = 0; index < output.length; index += 1) {
    const position = (index * from) / to;
    const left = Math.min(samples.length - 1, Math.floor(position));
    const right = Math.min(samples.length - 1, left + 1);
    const a = samples[left] ?? 0;
    output[index] = a + ((samples[right] ?? a) - a) * (position - left);
  }
  return output;
}

/** AAC-LC, mono, 1024-sample frames: exactly the configuration requested.
 * Built rather than taken from the encoder's `description`, because WebKit
 * returns its AudioToolbox magic cookie (a whole ES_Descriptor) there. */
function audioSpecificConfig(rate: number) {
  const index = AAC_RATES.indexOf(rate);
  return Uint8Array.of((2 << 3) | (index >> 1), ((index & 1) << 7) | (1 << 3));
}

function concat(parts: readonly Uint8Array[]) {
  const output = new Uint8Array(
    parts.reduce((sum, part) => sum + part.length, 0),
  );
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
function u32(...values: number[]) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setUint32(index * 4, value);
  });
  return bytes;
}
function u16(...values: number[]) {
  const bytes = new Uint8Array(values.length * 2);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => {
    view.setUint16(index * 2, value);
  });
  return bytes;
}
function ascii(value: string) {
  return Uint8Array.from(value, (char) => char.charCodeAt(0));
}
function box(kind: string, ...parts: Uint8Array[]) {
  const body = concat(parts);
  return concat([u32(8 + body.length), ascii(kind), body]);
}
/** ES descriptor: tag, one-byte length (every descriptor here is < 128 bytes). */
function descriptor(tag: number, ...parts: Uint8Array[]) {
  const body = concat(parts);
  return concat([Uint8Array.of(tag, body.length), body]);
}

const MATRIX = u32(0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000);

/** One AAC track, one chunk, moov before mdat, and no udta/meta boxes. */
export function muxM4a(
  frames: readonly Uint8Array[],
  audioConfig: Uint8Array,
  rate: number,
): Uint8Array<ArrayBuffer> {
  const duration = frames.length * FRAME_SAMPLES;
  const bytes = frames.reduce((sum, frame) => sum + frame.length, 0);
  const average = Math.round((bytes * 8 * rate) / duration);
  const largest = Math.max(...frames.map((frame) => frame.length));
  const ftyp = box("ftyp", ascii("M4A "), u32(0), ascii("M4A isommp42"));
  const esds = box(
    "esds",
    u32(0),
    descriptor(
      3,
      u16(1),
      Uint8Array.of(0),
      descriptor(
        4,
        Uint8Array.of(0x40, 0x15, 0, (largest >> 8) & 0xff, largest & 0xff),
        u32(average, average),
        descriptor(5, audioConfig),
      ),
      descriptor(6, Uint8Array.of(2)),
    ),
  );
  const moov = (chunkOffset: number) =>
    box(
      "moov",
      box(
        "mvhd",
        u32(0, 0, 0, rate, duration, 0x10000),
        u16(0x100),
        new Uint8Array(10),
        MATRIX,
        new Uint8Array(24),
        u32(2),
      ),
      box(
        "trak",
        box(
          "tkhd",
          u32(3, 0, 0, 1, 0, duration, 0, 0),
          u16(0, 0, 0x100, 0),
          MATRIX,
          u32(0, 0),
        ),
        box(
          "mdia",
          box("mdhd", u32(0, 0, 0, rate, duration), u16(0x55c4, 0)),
          box(
            "hdlr",
            u32(0, 0),
            ascii("soun"),
            u32(0, 0, 0),
            ascii("SoundHandler\0"),
          ),
          box(
            "minf",
            box("smhd", u32(0, 0)),
            box("dinf", box("dref", u32(0, 1), box("url ", u32(1)))),
            box(
              "stbl",
              box(
                "stsd",
                u32(0, 1),
                box(
                  "mp4a",
                  new Uint8Array(6),
                  u16(1),
                  new Uint8Array(8),
                  u16(1, 16, 0, 0),
                  u32(rate << 16),
                  esds,
                ),
              ),
              box("stts", u32(0, 1, frames.length, FRAME_SAMPLES)),
              box("stsc", u32(0, 1, 1, frames.length, 1)),
              box(
                "stsz",
                u32(0, 0, frames.length),
                u32(...frames.map((frame) => frame.length)),
              ),
              box("stco", u32(0, 1, chunkOffset)),
            ),
          ),
        ),
      ),
    );
  // The offset field's width is fixed, so the first pass measures the final moov.
  const header = ftyp.length + moov(0).length + 8;
  return concat([ftyp, moov(header), u32(8 + bytes), ascii("mdat"), ...frames]);
}
