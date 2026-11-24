#include "triage/hello/engine.hpp"

#include "triage/hello/protocol.hpp"

#include <array>
#include <cstring>
#include <string_view>
#include <vector>

namespace triage::hello {
namespace {

bool send(Connection &connection, FrameType type, std::span<const std::byte> payload) {
  std::array<std::byte, kFrameHeader> header{};
  encode_header(type, static_cast<std::uint32_t>(payload.size()), header);
  return connection.write_all(header.data(), header.size()) &&
         (payload.empty() || connection.write_all(payload.data(), payload.size()));
}

bool send_text(Connection &connection, FrameType type, std::string_view text) {
  return send(connection, type, std::as_bytes(std::span{text.data(), text.size()}));
}

/// Sends `count` Data frames of `size` bytes each, then StreamEnd. Header and
/// payload go out in one write per frame.
bool stream(Connection &connection, std::uint32_t count, std::uint32_t size) {
  std::vector<std::byte> frame(kFrameHeader + size);
  encode_header(FrameType::Data, size,
                std::span<std::byte, kFrameHeader>{frame.data(), kFrameHeader});
  for (std::size_t i = 0; i < size; ++i) {
    frame[kFrameHeader + i] = static_cast<std::byte>(i & 0xffu);
  }
  std::uint64_t sent = 0;
  for (std::uint32_t i = 0; i < count; ++i) {
    if (!connection.write_all(frame.data(), frame.size())) {
      return false;
    }
    sent += size;
  }
  std::vector<std::byte> end;
  put_u64(end, sent);
  return send(connection, FrameType::StreamEnd, end);
}

} // namespace

int serve(Connection &connection) {
  if (!send_text(connection, FrameType::Hello, hello_payload(current_pid()))) {
    return 1;
  }
  std::array<std::byte, kFrameHeader> header{};
  std::vector<std::byte> payload;
  while (connection.read_exact(header.data(), header.size())) {
    FrameType type{};
    const auto size = decode_header(header, type);
    if (!size) {
      send_text(connection, FrameType::Error, "invalid frame length");
      return 3;
    }
    payload.resize(*size);
    if (*size > 0 && !connection.read_exact(payload.data(), *size)) {
      return 0;
    }
    bool ok = true;
    switch (type) {
    case FrameType::Ping:
      ok = send(connection, FrameType::Pong, payload);
      break;
    case FrameType::Stream: {
      const auto count = get_u32(payload, 0);
      const auto frame_size = get_u32(payload, 4);
      if (!count || !frame_size || *frame_size == 0 || *frame_size >= kMaxFrameBody) {
        ok = send_text(connection, FrameType::Error, "Stream needs u32 count, u32 size");
      } else {
        ok = stream(connection, *count, *frame_size);
      }
      break;
    }
    default:
      ok = send_text(connection, FrameType::Error, "unknown frame type");
      break;
    }
    if (!ok) {
      return 0; // the broker went away
    }
  }
  return 0;
}

} // namespace triage::hello
