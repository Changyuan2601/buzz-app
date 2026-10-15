# USB compute display

This firmware targets the **Waveshare ESP32-S3-Touch-AMOLED-1.8 V2**
(CO5300 display, CST820 touch, 16 MB flash). It mirrors the existing floating
compute widget on macOS, enlarged to 368×368 and centered on the 368×448 panel.
The graphics stay square; the widget's dark background fills the space above and below.
Panel brightness is 255/255, matching Waveshare's HelloWorld example.
The client sends up to 15 frames/second; actual throughput depends on the board.
Buzz owns all compute state, animation, and design selection. The device uses
the existing dark palette regardless of the desktop app's appearance. The board
receives only rendered pixels over USB; it needs no Wi-Fi or account credentials.
Touch and audio are not used.

## Build and install

Use Arduino CLI 1.5.1 and the Arduino ESP32 core **3.3.11**, matching
[Waveshare's examples](https://github.com/waveshareteam/ESP32-S3-Touch-AMOLED-1.8).
Download their source at commit
`78e13f852929c2ab4f9d5e0ad1c50ea378dbf2b4` and use
`examples/arduino-v2/libraries`. The display and expander reset setup follows
their Apache-2.0 `02_Drawing_board` example. Libraries retain their upstream
licenses; they are not vendored here.

From this repository, with `WAVESHARE_SOURCE` pointing at that extracted source:

```sh
arduino-cli core update-index --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core install esp32:esp32@3.3.11 --additional-urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli compile --fqbn esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=default --libraries "$WAVESHARE_SOURCE/examples/arduino-v2/libraries" --output-dir /tmp/buzz-compute-firmware firmware/compute-display
```

Before uploading, back up the **entire** existing flash with the core's esptool:
`esptool --chip esp32s3 --port PORT read-flash 0 0x1000000 original.bin`.
Keep that backup private and outside Git; it can include existing device data.
Uploading replaces the board's current application and partition table.
Close serial monitors and disconnect the widget's USB connection before flashing.

```sh
arduino-cli upload --fqbn esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=default --port PORT --input-dir /tmp/buzz-compute-firmware firmware/compute-display
```

Restore the backup with
`esptool --chip esp32s3 --port PORT write-flash 0 original.bin`.
Use the board's USB-C connection; BOOT/reset can restore download mode if needed.

## Try it

Run the native Buzz app from this checkout (`BUZZ_DEV_VIEWER= bin/just desktop`).
In Settings → selected community → Shared compute, enable sharing. The small
pop-out arrow at the top right of the animated activity tile opens a separate
floating **Compute** window. Open its top-left menu or press **⌘,** while the widget
is focused (**Ctrl+,** on other platforms). Connect exactly one USB serial device,
then choose **Connect USB** in Widget settings. Successful pairing shows the port
and changes the action to **Disconnect USB**. Use the menu again or Escape to return
to the animation. **Close widget** is in the same settings panel. Click the widget canvas to
cycle the existing designs; the board follows. The connection lasts for that
widget window and must be explicitly re-enabled when reopened.

The native host accepts only `/dev/cu.usbmodem*` devices and checks the firmware
handshake before streaming. Partial packets expire after one second; the host
establishes a 1.1-second quiet period before each handshake. Frames are fixed
128×128 little-endian RGB565, preceded by `BUZZ128\n`, followed by a little-endian
FNV-1a 32-bit checksum. Firmware acknowledges only a verified, displayed frame.
Only one frame can be pending, so a slow device never accumulates a frame queue.
Unplugging produces **Retry USB** and the error in settings. The board shows its connection screen
after three seconds without a new frame. Reconnect and click USB to resume.
Closing the widget releases the serial device without stopping shared compute.

## Focused checks

```sh
bin/pnpm exec vitest run browser-host/compute-widget-usb.test.mjs browser-host/compute-widget.test.mjs
bin/cargo test -p buzz-foundation --lib mesh_compute::usb_display --features mesh
xcrun clang++ -std=c++17 -Wall -Wextra -Werror firmware/tests/protocol.test.cpp -o /tmp/buzz-compute-protocol-test
/tmp/buzz-compute-protocol-test
```

The C++ test exercises the actual firmware parser, including corrupt/truncated
frames and quiet-period recovery. Vitest covers explicit connection, RGB565
encoding, backpressure, failure, disconnect during a pending frame, and disposal.
Rust covers fragmented replies, deadlines, disconnection, and deferred cleanup.
These checks do not establish physical display output, throughput, or live Mesh
reactions; those need the board and the native app.

The opt-in physical test uses the same native transport as the widget. Supply a
32768-byte RGB565 capture from the widget and an explicit device:

```sh
BUZZ_USB_HARDWARE_PORT=/dev/cu.usbmodem101 BUZZ_USB_HARDWARE_FRAME=/absolute/path/widget.rgb565 bin/cargo test -p buzz-foundation --lib mesh_compute::usb_display::tests::physical_firmware_accepts_widget_frames_and_reconnects --features mesh -- --ignored --nocapture
```

On the connected V2 board with the 368×368 firmware, 30 rendered widget frames
were acknowledged in 6.43 seconds (about **4.7 fps**), and reconnect after a
deliberately truncated frame passed. The user confirmed live compute reactions
with the preceding firmware. The firmware RX queue holds
one complete frame because HWCDC drops bytes when its queue fills. The 15 fps
client limit is a ceiling, not a throughput promise. Human confirmation of the
enlarged graphics and manual unplug/reconnect remain acceptance checks.
The updated Provider app was exercised on macOS: ⌘, and the hamburger opened
settings, Escape returned to the animation, USB connected, and closing from
settings released the port while sharing stayed enabled. Reopening and connecting
again also passed. Focused widget tests, typecheck, native bundle/signature checks,
and the widget's icon boundary passed. The repository-wide icon check still
reports unrelated existing Maps/Mapbox classification errors.
