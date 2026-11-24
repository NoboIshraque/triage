#include "triage/hello/transport.hpp"

#include <chrono>
#include <thread>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#else
#include <cerrno>
#include <cstring>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace triage::hello {
namespace {

using Clock = std::chrono::steady_clock;

#ifdef _WIN32

class PipeConnection final : public Connection {
public:
  explicit PipeConnection(HANDLE pipe) : pipe_(pipe) {}
  ~PipeConnection() override { CloseHandle(pipe_); }
  PipeConnection(const PipeConnection &) = delete;
  PipeConnection &operator=(const PipeConnection &) = delete;

  bool read_exact(void *data, std::size_t size) override {
    auto *bytes = static_cast<char *>(data);
    while (size > 0) {
      DWORD got = 0;
      const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
      if (!ReadFile(pipe_, bytes, chunk, &got, nullptr) || got == 0) {
        return false;
      }
      bytes += got;
      size -= got;
    }
    return true;
  }

  bool write_all(const void *data, std::size_t size) override {
    const auto *bytes = static_cast<const char *>(data);
    while (size > 0) {
      DWORD put = 0;
      const auto chunk = static_cast<DWORD>(size > (1u << 30) ? (1u << 30) : size);
      if (!WriteFile(pipe_, bytes, chunk, &put, nullptr) || put == 0) {
        return false;
      }
      bytes += put;
      size -= put;
    }
    return true;
  }

private:
  HANDLE pipe_;
};

std::wstring widen(const std::string &text) {
  if (text.empty()) {
    return {};
  }
  const int size =
      MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0);
  std::wstring wide(static_cast<std::size_t>(size), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), wide.data(), size);
  return wide;
}

#else

class SocketConnection final : public Connection {
public:
  explicit SocketConnection(int fd) : fd_(fd) {}
  ~SocketConnection() override { ::close(fd_); }
  SocketConnection(const SocketConnection &) = delete;
  SocketConnection &operator=(const SocketConnection &) = delete;

  bool read_exact(void *data, std::size_t size) override {
    auto *bytes = static_cast<char *>(data);
    while (size > 0) {
      const ssize_t got = ::read(fd_, bytes, size);
      if (got < 0 && errno == EINTR) {
        continue;
      }
      if (got <= 0) {
        return false;
      }
      bytes += got;
      size -= static_cast<std::size_t>(got);
    }
    return true;
  }

  bool write_all(const void *data, std::size_t size) override {
    const auto *bytes = static_cast<const char *>(data);
    while (size > 0) {
      const ssize_t put = ::send(fd_, bytes, size, MSG_NOSIGNAL);
      if (put < 0 && errno == EINTR) {
        continue;
      }
      if (put <= 0) {
        return false;
      }
      bytes += put;
      size -= static_cast<std::size_t>(put);
    }
    return true;
  }

private:
  int fd_;
};

#endif

} // namespace

std::unique_ptr<Connection> connect_to(const std::string &endpoint, int timeout_ms,
                                       std::string &error) {
  const auto deadline = Clock::now() + std::chrono::milliseconds(timeout_ms);
  for (;;) {
#ifdef _WIN32
    const std::wstring name = widen(endpoint);
    HANDLE pipe = CreateFileW(name.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING,
                              0, nullptr);
    if (pipe != INVALID_HANDLE_VALUE) {
      return std::make_unique<PipeConnection>(pipe);
    }
    error = "cannot open pipe " + endpoint + " (error " + std::to_string(GetLastError()) + ")";
    if (GetLastError() == ERROR_PIPE_BUSY) {
      WaitNamedPipeW(name.c_str(), 100);
    }
#else
    sockaddr_un address{};
    if (endpoint.size() >= sizeof(address.sun_path)) {
      error = "socket path too long: " + endpoint;
      return nullptr;
    }
    const int fd = ::socket(AF_UNIX, SOCK_STREAM, 0);
    if (fd < 0) {
      error = std::string("socket: ") + std::strerror(errno);
      return nullptr;
    }
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, endpoint.c_str(), endpoint.size() + 1);
    if (::connect(fd, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) == 0) {
      return std::make_unique<SocketConnection>(fd);
    }
    error = "cannot connect to " + endpoint + ": " + std::strerror(errno);
    ::close(fd);
#endif
    if (Clock::now() >= deadline) {
      return nullptr;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(20));
  }
}

long current_pid() noexcept {
#ifdef _WIN32
  return static_cast<long>(GetCurrentProcessId());
#else
  return static_cast<long>(::getpid());
#endif
}

} // namespace triage::hello
