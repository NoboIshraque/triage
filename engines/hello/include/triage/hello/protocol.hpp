#pragma once

// Frames between an engine and its broker (ROADMAP P0-4, PLAN §4.2):
//   u32 little-endian length of (type + payload), u8 type, payload bytes.
// The same layout is implemented in TypeScript in
// app/src/vs/triage/node/engineProtocol.ts.

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <vector>

namespace triage::hello {

enum class FrameType : std::uint8_t {
  Hello = 0x01,     // engine -> broker: "name version pid"
  Ping = 0x02,      // broker -> engine: any payload
  Pong = 0x03,      // engine -> broker: the ping's payload
  Stream = 0x10,    // broker -> engine: u32 frame count, u32 frame size
  Data = 0x11,      // engine -> broker: one data frame
  StreamEnd = 0x12, // engine -> broker: u64 bytes sent
  Error = 0x7f,     // engine -> broker: message
};

/// Largest frame body (type + payload) either side accepts: 64 MiB.
inline constexpr std::uint32_t kMaxFrameBody = 64u * 1024u * 1024u;

/// Size of the length prefix plus the type byte.
inline constexpr std::size_t kFrameHeader = 5;

struct Frame {
  FrameType type;
  std::vector<std::byte> payload;
};

/// Writes the 5-byte header for a frame with `payload_size` bytes of payload.
void encode_header(FrameType type, std::uint32_t payload_size,
                   std::span<std::byte, kFrameHeader> out) noexcept;

/// Reads a header. Returns the payload size, or nothing if the length is invalid.
[[nodiscard]] std::optional<std::uint32_t>
decode_header(std::span<const std::byte, kFrameHeader> header, FrameType &type) noexcept;

void put_u32(std::vector<std::byte> &out, std::uint32_t value);
void put_u64(std::vector<std::byte> &out, std::uint64_t value);
[[nodiscard]] std::optional<std::uint32_t> get_u32(std::span<const std::byte> in,
                                                   std::size_t offset) noexcept;

/// The payload of the Hello frame: "triage-hello-engine <version> <pid>".
[[nodiscard]] std::string hello_payload(long pid);

} // namespace triage::hello
