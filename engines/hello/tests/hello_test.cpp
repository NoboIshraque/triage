// Dependency-free unit test for the hello engine (no test framework to fetch).
#include "triage/hello/hello.hpp"

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

  if (failures == 0) {
    std::puts("hello engine: all checks passed");
  }
  return failures == 0 ? 0 : 1;
}
