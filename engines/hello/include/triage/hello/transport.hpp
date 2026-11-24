#pragma once

// A byte stream to the broker: a Unix domain socket on Linux and macOS, a named
// pipe on Windows. The only platform-specific code in the hello engine
// (GUIDELINES §8: platform code behind small interfaces).

#include <cstddef>
#include <memory>
#include <string>

namespace triage::hello {

class Connection {
public:
  virtual ~Connection() = default;
  /// Reads exactly `size` bytes. False on end of stream or error.
  virtual bool read_exact(void *data, std::size_t size) = 0;
  /// Writes all `size` bytes. False on error.
  virtual bool write_all(const void *data, std::size_t size) = 0;
};

/// Connects to the broker's endpoint: a socket path, or \\.\pipe\name on
/// Windows. Retries for up to `timeout_ms` while the broker starts listening.
/// Returns null and fills `error` on failure.
[[nodiscard]] std::unique_ptr<Connection> connect_to(const std::string &endpoint, int timeout_ms,
                                                     std::string &error);

/// This process's id.
[[nodiscard]] long current_pid() noexcept;

} // namespace triage::hello
