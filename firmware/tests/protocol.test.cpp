#include "../compute-display/protocol.h"
#include <assert.h>

int main() {
  BuzzFrame frame;
  uint32_t now = 0;
  auto line = [&](const char *text) {
    auto result = BuzzFrame::None;
    while (*text) result = frame.feed(*text++, now);
    return result;
  };
  assert(line("garbage\nBUZZ?\n") == BuzzFrame::Hello);
  auto packet = [&](bool corrupt) {
    line("BUZZ128\n");
    uint32_t hash = 2166136261u;
    for (uint32_t i = 0; i < sizeof(frame.pixels); ++i) {
      const uint8_t byte = i & 255;
      hash = (hash ^ byte) * 16777619u;
      assert(frame.feed(byte, now) == BuzzFrame::None);
    }
    if (corrupt) hash ^= 1;
    auto result = BuzzFrame::None;
    for (uint32_t i = 0; i < 4; ++i) result = frame.feed(hash >> (i * 8), now);
    return result;
  };
  assert(packet(false) == BuzzFrame::Frame);
  assert(frame.pixels[255] == 255 && frame.pixels[256] == 0);
  assert(packet(true) == BuzzFrame::Bad);
  assert(packet(false) == BuzzFrame::Frame);
  line("BUZZ128\n");
  frame.feed(1, now);
  now += 100;
  assert(line("BUZZ?\n") == BuzzFrame::None); // Still an incomplete payload.
  now += 1100;  // Host establishes a quiet period before its real handshake.
  assert(line("BUZZ?\n") == BuzzFrame::Hello);
  assert(packet(false) == BuzzFrame::Frame);
  now = UINT32_MAX - 5;
  line("BUZZ128\n");
  now = 3;  // millis() wraps without terminating a valid in-progress packet.
  frame.feed(42, now);
  assert(frame.receiving);
}
