import { afterEach, expect, test, vi } from "vitest";
import { encodeVoiceNoteWav } from "../../bundled/voice-notes/voiceNoteWav";
import { brokerUpload, UploadError, uploadVoiceNoteM4a } from "./attachments";
import { encodeVoiceNoteM4a } from "./voice-m4a";

// The relay's MP4 box allow-list (block/buzz crates/buzz-media validation.rs).
const RELAY_BOXES = new Set([
  ...["ftyp", "moov", "mdat", "free", "skip", "wide", "trak", "mdia", "minf"],
  ...["stbl", "edts", "dinf", "sinf", "schi", "udta", "mvhd", "tkhd", "mdhd"],
  ...["hdlr", "vmhd", "smhd", "dref", "url ", "urn ", "stsd", "stts", "stss"],
  ...["ctts", "stsc", "stsz", "stco", "co64", "sgpd", "sbgp", "sdtp", "elst"],
]);
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf"]);

type Box = { kind: string; start: number; end: number; children: Box[] };
function boxes(bytes: Uint8Array, start = 0, end = bytes.length): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const out: Box[] = [];
  for (let offset = start; offset < end; ) {
    const size = view.getUint32(offset);
    const kind = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    expect(size).toBeGreaterThanOrEqual(8);
    expect(offset + size).toBeLessThanOrEqual(end);
    out.push({
      kind,
      start: offset,
      end: offset + size,
      children: CONTAINERS.has(kind)
        ? boxes(bytes, offset + 8, offset + size)
        : [],
    });
    offset += size;
  }
  return out;
}
const find = (list: Box[], path: string[]): Box | undefined => {
  const [head, ...rest] = path;
  const hit = list.find((item) => item.kind === head);
  return hit && rest.length ? find(hit.children, rest) : hit;
};
const walk = (list: Box[]): string[] =>
  list.flatMap((item) => [item.kind, ...walk(item.children)]);

const FRAMES = [
  Uint8Array.of(1, 2, 3),
  Uint8Array.of(4, 5),
  Uint8Array.of(6, 7, 8, 9),
];
const encoded: { configs: AudioEncoderConfig[]; samples: number } = {
  configs: [],
  samples: 0,
};
function fakeWebCodecs(supportedRates: number[]) {
  encoded.configs = [];
  encoded.samples = 0;
  class FakeAudioData {
    numberOfFrames: number;
    constructor(init: { numberOfFrames: number }) {
      this.numberOfFrames = init.numberOfFrames;
    }
    close() {}
  }
  class FakeAudioEncoder {
    state = "unconfigured";
    #output: AudioEncoderInit["output"];
    constructor(init: AudioEncoderInit) {
      this.#output = init.output;
    }
    static async isConfigSupported(config: AudioEncoderConfig) {
      return { supported: supportedRates.includes(config.sampleRate), config };
    }
    configure(config: AudioEncoderConfig) {
      encoded.configs.push(config);
      this.state = "configured";
    }
    encode(data: FakeAudioData) {
      encoded.samples += data.numberOfFrames;
    }
    async flush() {
      for (const frame of FRAMES)
        this.#output(
          {
            byteLength: frame.length,
            copyTo: (target: Uint8Array) => target.set(frame),
          } as unknown as EncodedAudioChunk,
          // WebKit's description is an ES_Descriptor, not an AudioSpecificConfig.
          {
            decoderConfig: {
              codec: "mp4a.40.2",
              sampleRate: 0,
              numberOfChannels: 1,
              description: Uint8Array.of(3, 0x80, 0x80, 0x80, 2, 0x13, 8),
            },
          },
        );
    }
    close() {
      this.state = "closed";
    }
  }
  vi.stubGlobal("AudioEncoder", FakeAudioEncoder);
  vi.stubGlobal("AudioData", FakeAudioData);
}
afterEach(() => {
  vi.unstubAllGlobals();
});

const wav = () =>
  new File(
    [
      new Uint8Array(
        encodeVoiceNoteWav([new Float32Array(2_400).fill(0.25)], 24_000),
      ),
    ],
    "voice-note-7.wav",
    {
      type: "audio/wav",
    },
  );
const signal = () => new AbortController().signal;

test("encodes the recorder's WAV as a fast-start, metadata-free AAC .m4a", async () => {
  fakeWebCodecs([24_000]);
  const file = await encodeVoiceNoteM4a(wav(), signal());
  expect(file?.name).toBe("voice-note-7.m4a");
  expect(file?.type).toBe("audio/mp4");
  expect(encoded.configs).toEqual([
    {
      codec: "mp4a.40.2",
      sampleRate: 24_000,
      numberOfChannels: 1,
      bitrate: 64_000,
    },
  ]);
  expect(encoded.samples).toBe(2_400);
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  const tree = boxes(bytes);
  expect(tree.map((item) => item.kind)).toEqual(["ftyp", "moov", "mdat"]);
  for (const kind of walk(tree)) expect(RELAY_BOXES).toContain(kind);
  expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("M4A ");
  const view = new DataView(bytes.buffer);
  const stbl = ["moov", "trak", "mdia", "minf", "stbl"];
  const stco = find(tree, [...stbl, "stco"]) as Box;
  const mdat = find(tree, ["mdat"]) as Box;
  expect(view.getUint32(stco.start + 16)).toBe(mdat.start + 8);
  expect([...bytes.subarray(mdat.start + 8, mdat.end)]).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9,
  ]);
  const stsz = find(tree, [...stbl, "stsz"]) as Box;
  expect(
    [0, 1, 2].map((index) => view.getUint32(stsz.start + 20 + index * 4)),
  ).toEqual([3, 2, 4]);
  const mdhd = find(tree, ["moov", "trak", "mdia", "mdhd"]) as Box;
  expect(view.getUint32(mdhd.start + 20)).toBe(24_000);
  expect(view.getUint32(mdhd.start + 24)).toBe(3 * 1024);
  // esds carries the AudioSpecificConfig (AAC-LC, 24 kHz, mono), not the encoder's description.
  const stsd = find(tree, [...stbl, "stsd"]) as Box;
  const entry = bytes.subarray(stsd.start, stsd.end);
  expect(String.fromCharCode(...entry.subarray(20, 24))).toBe("mp4a");
  expect(entry.join(",")).toContain("5,2,19,8");
});

test("encodes at 48 kHz when the encoder rejects the recording rate", async () => {
  fakeWebCodecs([48_000]);
  const file = await encodeVoiceNoteM4a(wav(), signal());
  expect(encoded.configs[0]?.sampleRate).toBe(48_000);
  expect(encoded.samples).toBe(4_800);
  const bytes = new Uint8Array(await (file as File).arrayBuffer());
  // AAC-LC (2), 48 kHz (index 3), mono.
  expect(bytes.join(",")).toContain("5,2,17,136");
});

test("no AAC encoder, or a file that is not the recorder's WAV, means no .m4a", async () => {
  expect(await encodeVoiceNoteM4a(wav(), signal())).toBeUndefined();
  fakeWebCodecs([]);
  expect(await encodeVoiceNoteM4a(wav(), signal())).toBeUndefined();
  fakeWebCodecs([24_000]);
  const other = new File([new Uint8Array(64)], "voice-note-1.wav");
  expect(await encodeVoiceNoteM4a(other, signal())).toBeUndefined();
});

test("an older relay's rejection falls back; other upload failures do not", async () => {
  fakeWebCodecs([24_000]);
  const result = {
    name: "voice-note-7.m4a",
    url: "https://relay.test/media/x.m4a",
    type: "audio/mp4",
    size: 1,
    sha256: "a".repeat(64),
  };
  const ok = vi.fn().mockResolvedValue(result);
  expect(await uploadVoiceNoteM4a(wav(), signal(), undefined, ok)).toBe(result);
  expect(ok.mock.calls[0]?.[0]).toMatchObject({ type: "audio/mp4" });
  const rejected = vi.fn().mockRejectedValue(new UploadError("rejected"));
  expect(
    await uploadVoiceNoteM4a(wav(), signal(), undefined, rejected),
  ).toBeUndefined();
  const denied = vi.fn().mockRejectedValue(new UploadError("denied"));
  await expect(
    uploadVoiceNoteM4a(wav(), signal(), undefined, denied),
  ).rejects.toThrow(UploadError);
  vi.unstubAllGlobals();
  const unused = vi.fn();
  expect(
    await uploadVoiceNoteM4a(wav(), signal(), undefined, unused),
  ).toBeUndefined();
  expect(unused).not.toHaveBeenCalled();
});

test("the broker uploads voice notes as .m4a and uses ffmpeg only after an older relay rejects it", async () => {
  fakeWebCodecs([24_000]);
  const origin = "https://relay.test";
  const descriptor = (type: string, ext: string, size: number) =>
    Response.json({
      url: `${origin}/media/${"a".repeat(64)}.${ext}`,
      type,
      size,
      sha256: "a".repeat(64),
    });
  const sent: string[] = [];
  let relayTakesAudio = true;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const body = init.body as File;
    sent.push(`${url.split("/").pop()} ${body.type}`);
    if (url.endsWith("/prepare-media"))
      return new Response(new Uint8Array(5), {
        headers: { "content-type": "video/mp4", "content-length": "5" },
      });
    if (body.type === "audio/mp4" && !relayTakesAudio)
      return new Response("disallowed content type: audio/mp4", {
        status: 415,
      });
    return body.type === "audio/mp4"
      ? descriptor("audio/mp4", "m4a", body.size)
      : descriptor("video/mp4", "mp4", body.size);
  });
  const upload = brokerUpload("/api/relay", origin);
  expect(await upload(wav(), signal())).toMatchObject({
    name: "voice-note-7.m4a",
    type: "audio/mp4",
  });
  expect(sent).toEqual(["upload audio/mp4"]);
  sent.length = 0;
  relayTakesAudio = false;
  expect(await upload(wav(), signal())).toMatchObject({
    name: "voice-note-7.mp4",
    type: "video/mp4",
  });
  expect(sent).toEqual([
    "upload audio/mp4",
    "prepare-media audio/wav",
    "upload video/mp4",
  ]);
});
