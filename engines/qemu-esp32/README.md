# engines/qemu-esp32/: ESP32 emulator

Espressif's QEMU fork, pinned to a commit, plus Triage's C peripheral models for
what it lacks: GPIO matrix/IOMUX, ADC, I²C, SPI, RMT, LEDC on S3/C3
([ADR 0003](../../docs/adr/0003-boards-and-windows.md)). Arrives in ROADMAP **P4-1**.

Planned layout: `upstream/` · `patches/` · `triage/` (peripheral models).
