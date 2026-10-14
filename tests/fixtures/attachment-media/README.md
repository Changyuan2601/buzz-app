# Generated attachment fixtures

Tiny synthetic images, no user media. `still.png` and animations were generated
with local image/ffmpeg tooling. `profile.webp` is an ICC-bearing still (the
profile forces the pixel-transform/lossless-encoder path). `one-page.pdf` (a
red rectangle on a 200x100 pt page) and `two-pages.pdf` are hand-assembled
minimal PDFs for page rasterization and its multi-page fallback. Browser tests add
snapshot/comment metadata themselves, then invoke production preparation.

These fixtures exercise decoding, structural metadata cleanup, preservation of
animation containers and the WebKit lossless WebP worker. They are not live
relay acceptance or maximum-size evidence.
