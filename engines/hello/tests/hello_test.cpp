// Dependency-free unit test for the hello engine (no test framework to fetch).
#include "triage/hello/hello.hpp"
#include "triage/hello/protocol.hpp"

#include <array>
#include <cstdio>
#include <string_view>

namespace {

int failures = 0;

void check(bool ok, std::string_view what) {
  if (!ok) {
    ++failures;
    std::fprintf(stderr, "FAIL: %.*s\n", static_cast<int>(what.size()), what.data());
  }
}

} // namespace

int main() {
  using namespace triage::hello;

  check(engine_name() == "triage-hello-engine", "engine name");
  check(!version().empty(), "version is set");
  check(version_line() == std::string{engine_name()} + ' ' + std::string{version()} + '\n',
        "version line");

  const std::array<std::string_view, 1> version_flag{"--version"};
  const auto ok = run(version_flag);
  check(ok.exit_code == 0 && ok.out == version_line() && ok.err.empty(), "--version");

  const std::array<std::string_view, 1> bad{"--frobnicate"};
  const auto rejected = run(bad);
  check(rejected.exit_code == 2 && rejected.out.empty(), "unknown argument exit code");
  check(rejected.err.find("--frobnicate") != std::string::npos, "unknown argument message");

  const auto none = run({});
  check(none.exit_code == 0 && none.out.starts_with("usage:"), "no arguments prints usage");

  // Frame header: u32 LE length of (type + payload), then the type byte.
  std::array<std::byte, kFrameHeader> header{};
  encode_header(FrameType::Data, 0x01020304u, header);
  check(header[0] == std::byte{0x05} && header[1] == std::byte{0x03} &&
            header[2] == std::byte{0x02} && header[3] == std::byte{0x01} &&
            header[4] == std::byte{0x11},
        "header layout");
  FrameType type{};
  encode_header(FrameType::Pong, 7, header);
  check(decode_header(header, type) == 7u && type == FrameType::Pong, "header round trip");
  const std::array<std::byte, kFrameHeader> empty{};
  check(!decode_header(empty, type).has_value(), "zero-length frame rejected");
  encode_header(FrameType::Data, kMaxFrameBody, header);
  check(!decode_header(header, type).has_value(), "oversized frame rejected");

  std::vector<std::byte> bytes;
  put_u32(bytes, 0xdeadbeefu);
  check(get_u32(bytes, 0) == 0xdeadbeefu && !get_u32(bytes, 1).has_value(), "u32 codec");
  check(hello_payload(42) == std::string{engine_name()} + ' ' + std::string{version()} + " 42",
        "hello payload");

  if (failures == 0) {
    std::puts("hello engine: all checks passed");
  }
  return failures == 0 ? 0 : 1;
}
