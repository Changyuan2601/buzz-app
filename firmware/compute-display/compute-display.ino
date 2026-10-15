// Display/reset pins follow Waveshare's Apache-2.0 Drawing_board example at
// 78e13f852929c2ab4f9d5e0ad1c50ea378dbf2b4. See ../README.md.
#include <Arduino_GFX_Library.h>
#include <Adafruit_XCA9554.h>
#include <HWCDC.h>
#include <Wire.h>
#include <esp_heap_caps.h>
#include "protocol.h"

HWCDC usb;
Adafruit_XCA9554 expander;
Arduino_ESP32QSPI bus(12, 11, 4, 5, 6, 7);
Arduino_CO5300 display(&bus, GFX_NOT_DEFINED, 0, 368, 448, 16, 0, 0, 0);
BuzzFrame parser;
uint16_t *scaled = nullptr;
uint32_t lastFrame = 0;
bool waiting = true;
bool initialized = false;

void waitingScreen() {
  display.fillScreen(RGB565_BLACK);
  display.setTextSize(2);
  display.setTextColor(RGB565_WHITE);
  display.setCursor(52, 195);
  display.println("Buzz compute display");
  display.setCursor(52, 230);
  display.println("Connect USB in Buzz");
}

void setup() {
  // HWCDC drops bytes when its queue fills; one complete frame can arrive in
  // a USB burst before loop() drains it. The host waits for ACK before the next.
  if (usb.setRxBufferSize(sizeof(parser.pixels) + 12) == 0) return;
  usb.begin(115200);
  usb.setTxTimeoutMs(100);
  Wire.begin(15, 14);
  if (!expander.begin(0x20)) return;
  for (uint8_t pin = 0; pin < 3; pin++) {
    expander.pinMode(pin, OUTPUT);
    expander.digitalWrite(pin, LOW);
  }
  delay(20);  // Hardware reset pulse, matching the board's manufacturer example.
  for (uint8_t pin = 0; pin < 3; pin++) expander.digitalWrite(pin, HIGH);
  if (!display.begin()) return;
  // Keep the enlarged frame in this board's 8 MB PSRAM.
  scaled = static_cast<uint16_t *>(heap_caps_malloc(368 * 368 * sizeof(uint16_t), MALLOC_CAP_SPIRAM));
  if (!scaled) return;
  display.setBrightness(255);  // CO5300 uses a 0–255 level, not a percentage.
  waitingScreen();
  initialized = true;
}

void loop() {
  if (!initialized) {
    delay(100);
    return;
  }
  while (usb.available()) {
    const auto result = parser.feed(usb.read(), millis());
    if (result == BuzzFrame::Hello) usb.print("BUZZ128/1\n");
    if (result == BuzzFrame::Bad) usb.write(21);
    if (result != BuzzFrame::Frame) continue;
    // Preserve the square widget at full panel width, centered vertically.
    for (int y = 0; y < 368; y++) {
      for (int x = 0; x < 368; x++) {
        const int source = ((y * 128 / 368) * 128 + x * 128 / 368) * 2;
        scaled[y * 368 + x] = parser.pixels[source] |
          (uint16_t(parser.pixels[source + 1]) << 8);
      }
    }
    if (waiting) display.fillScreen(scaled[0]);
    display.draw16bitRGBBitmap(0, 40, scaled, 368, 368);
    waiting = false;
    lastFrame = millis();
    usb.write(6);  // ACK only after checksum validation and display transfer.
  }
  if (!waiting && uint32_t(millis() - lastFrame) > 3000) {
    waiting = true;
    waitingScreen();
  }
  delay(1);  // Yield to USB/FreeRTOS while waiting for the next frame.
}
