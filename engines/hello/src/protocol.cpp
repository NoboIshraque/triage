#include "triage/hello/protocol.hpp"

#include "triage/hello/hello.hpp"

namespace triage::hello {

void encode_header(FrameType type, std::uint32_t payload_size,
                   std::span<std::byte, kFrameHeader> out) noexcept {
  const std::uint32_t body = payload_size + 1;
  for (std::size_t i = 0; i < 4; ++i) {
    out[i] = static_cast<std::byte>((body >> (8 * i)) & 0xffu);
  }
  out[4] = static_cast<std::byte>(type);
}

std::optional<std::uint32_t> decode_header(std::span<const std::byte, kFrameHeader> header,
                                           FrameType &type) noexcept {
  std::uint32_t body = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    body |= static_cast<std::uint32_t>(header[i]) << (8 * i);
  }
  if (body == 0 || body > kMaxFrameBody) {
    return std::nullopt;
  }
  type = static_cast<FrameType>(header[4]);
  return body - 1;
}

void put_u32(std::vector<std::byte> &out, std::uint32_t value) {
  for (std::size_t i = 0; i < 4; ++i) {
    out.push_back(static_cast<std::byte>((value >> (8 * i)) & 0xffu));
  }
}

void put_u64(std::vector<std::byte> &out, std::uint64_t value) {
  for (std::size_t i = 0; i < 8; ++i) {
    out.push_back(static_cast<std::byte>((value >> (8 * i)) & 0xffu));
  }
}

std::optional<std::uint32_t> get_u32(std::span<const std::byte> in, std::size_t offset) noexcept {
  if (in.size() < offset + 4) {
    return std::nullopt;
  }
  std::uint32_t value = 0;
  for (std::size_t i = 0; i < 4; ++i) {
    value |= static_cast<std::uint32_t>(in[offset + i]) << (8 * i);
  }
  return value;
}

std::string hello_payload(long pid) {
  std::string text{engine_name()};
  text += ' ';
  text += version();
  text += ' ';
  text += std::to_string(pid);
  return text;
}

} // namespace triage::hello
