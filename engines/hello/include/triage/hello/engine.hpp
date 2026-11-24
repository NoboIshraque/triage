#pragma once

#include "triage/hello/transport.hpp"

namespace triage::hello {

/// Serves one broker connection until the broker closes it: sends Hello,
/// answers Ping with Pong, and answers Stream with that many Data frames
/// followed by StreamEnd. Returns the process exit code.
int serve(Connection &connection);

} // namespace triage::hello
