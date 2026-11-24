#pragma once

#include <span>
#include <string>
#include <string_view>

namespace triage::hello {

/// The engine's executable name, as reported by `--version`.
[[nodiscard]] std::string_view engine_name() noexcept;

/// The Triage version this engine was built from.
[[nodiscard]] std::string_view version() noexcept;

/// The line printed by `--version`, ending in a newline.
[[nodiscard]] std::string version_line();

/// What the engine should do for its command line.
struct Invocation {
  int exit_code = 0;
  std::string out;
  std::string err;
};

/// Interprets the command-line arguments (without the program name).
[[nodiscard]] Invocation run(std::span<const std::string_view> args);

} // namespace triage::hello
