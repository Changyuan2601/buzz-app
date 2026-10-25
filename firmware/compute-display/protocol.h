#pragma once
#include <stdint.h>
#include <string.h>

// Fixed-size packets keep allocation and input bounds independent of the host.
struct BuzzFrame {
  enum Result { None, Hello, Frame, Bad };
  uint8_t pixels[32768] = {};
  char line[12] = {};
  uint32_t hash = 2166136261u, receivedHash = 0, lastByte = 0;
  uint32_t offset = 0;
  uint8_t lineSize = 0;
  bool receiving = false;

  Result feed(uint8_t byte, uint32_t now) {
    if (uint32_t(now - lastByte) > 1000) {
      receiving = false;
      lineSize = 0;
    }
    lastByte = now;
    if (!receiving) {
      if (byte == '\n') {
        line[lineSize] = 0;
        lineSize = 0;
        if (!strcmp(line, "BUZZ?")) return Hello;
        if (!strcmp(line, "BUZZ128")) {
          receiving = true;
          offset = 0;
          hash = 2166136261u;
          receivedHash = 0;
        }
      } else if (lineSize < sizeof(line) - 1) line[lineSize++] = byte;
      else lineSize = 0;
      return None;
    }
    if (offset < sizeof(pixels)) {
      pixels[offset] = byte;
      hash = (hash ^ byte) * 16777619u;
    } else receivedHash |= uint32_t(byte) << ((offset - sizeof(pixels)) * 8);
    if (++offset != sizeof(pixels) + 4) return None;
    receiving = false;
    return hash == receivedHash ? Frame : Bad;
  }
};
