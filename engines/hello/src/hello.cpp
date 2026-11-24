#include "triage/hello/hello.hpp"

#ifndef TRIAGE_VERSION
#error "TRIAGE_VERSION must be defined by the build"
#endif

namespace triage::hello {

std::string_view engine_name() noexcept {
  return "triage-hello-engine";
}

std::string_view version() noexcept {
  return TRIAGE_VERSION;
}

std::string version_line() {
  std::string line{engine_name()};
  line += ' ';
  line += version();
  line += '\n';
  return line;
}

Invocation run(std::span<const std::string_view> args) {
  if (args.empty()) {
    return {0, "usage: triage-hello-engine --version\n", {}};
  }
  if (args.size() == 1 && (args[0] == "--version" || args[0] == "-v")) {
    return {0, version_line(), {}};
  }
  std::string err{engine_name()};
  err += ": unknown argument '";
  err += args[0];
  err += "'\n";
  return {2, {}, err};
}

} // namespace triage::hello
