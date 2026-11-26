/*
 * triage-eda-engine: request routing between the broker and the kiface faces.
 * GPL-3.0-or-later.
 */

#pragma once

#include <string>

class KIWAY;

namespace TRIAGE
{

/// "triage-eda-engine <version>".
std::string EngineVersion();

/// Runs the command line (--connect, --load-all, --dump). Returns the exit code.
int RunHost( KIWAY& aKiway, int aArgc, char** aArgv );

} // namespace TRIAGE
