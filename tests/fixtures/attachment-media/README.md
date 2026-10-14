# Generated attachment fixtures

Tiny synthetic images, no user media. `still.png` and animations were generated
with local image/ffmpeg tooling. `profile.webp` is an ICC-bearing still (the
profile forces the pixel-transform/lossless-encoder path). `one-page.pdf` (a
red rectangle on a 200x100 pt page) and `two-pages.pdf` are hand-assembled
minimal PDFs for page rasterization and its multi-page fallback; `jpx-page.pdf`
wraps a Pillow-encoded red 200x100 JPEG 2000 image (`/JPXDecode`), a decoder
pdf.js only ships as wasm, and `blank-page.pdf` has an empty content stream;
both exercise the keep-as-file fallback. `hairline-page.pdf` is a letter page
whose only ink is a 0.5 pt rule (device row 761 at 2x), the sparse content a
sampled rather than box-filtered downscale misses in both engines. Browser
tests add snapshot/comment metadata themselves, then invoke production
preparation.

These fixtures exercise decoding, structural metadata cleanup, preservation of
animation containers and the WebKit lossless WebP worker. They are not live
relay acceptance or maximum-size evidence.
