#include "triage/hello/hello.hpp"

#include <cstdio>
#include <string_view>
#include <vector>

int main(int argc, char **argv) {
  std::vector<std::string_view> args;
  for (int i = 1; i < argc; ++i) {
    args.emplace_back(argv[i]);
  }
  const auto result = triage::hello::run(args);
  std::fputs(result.out.c_str(), stdout);
  std::fputs(result.err.c_str(), stderr);
  return result.exit_code;
}
