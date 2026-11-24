#include "triage/hello/engine.hpp"
#include "triage/hello/hello.hpp"
#include "triage/hello/transport.hpp"

#include <cstdio>
#include <string>
#include <string_view>
#include <vector>

int main(int argc, char **argv) {
  std::vector<std::string_view> args;
  for (int i = 1; i < argc; ++i) {
    args.emplace_back(argv[i]);
  }

  // Started by its broker (ROADMAP P0-4): connect back and serve frames.
  if (args.size() == 2 && args[0] == "--connect") {
    std::string error;
    auto connection = triage::hello::connect_to(std::string{args[1]}, 10'000, error);
    if (!connection) {
      std::fprintf(stderr, "triage-hello-engine: %s\n", error.c_str());
      return 2;
    }
    return triage::hello::serve(*connection);
  }

  const auto result = triage::hello::run(args);
  std::fputs(result.out.c_str(), stdout);
  std::fputs(result.err.c_str(), stderr);
  return result.exit_code;
}
