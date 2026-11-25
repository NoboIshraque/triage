/*
 * Triage: the engine face of a kiface (ROADMAP P1-2). GPL-3.0-or-later.
 *
 * triage-eda-engine loads KiCad's pcbnew and eeschema kifaces the way KiCad's
 * project manager and kicad-cli do (KIWAY). Built with KICAD_TRIAGE, each
 * kiface hands out its ENGINE_FACE for KIFACE_TRIAGE_ENGINE (patch 0001); the
 * face holds that kiface's open documents and answers requests about them.
 * Requests and responses are triage.eda.v1 messages (api/proto/), shared
 * through the triage_eda_api library, so they cross the kiface boundary as
 * objects.
 */

#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace triage::eda::v1
{
class Request;
class Response;
} // namespace triage::eda::v1

namespace TRIAGE
{

/// Receives one display-list chunk (stream_gal/display_list.h) to send as it is.
using BULK_SINK = std::function<void( std::string&& aChunk )>;

class ENGINE_FACE
{
public:
    virtual ~ENGINE_FACE() = default;

    /// "pcb" or "sch".
    virtual const char* Name() const = 0;

    /// True when this face opens files like `aPath` (by extension).
    virtual bool Accepts( const std::string& aPath ) const = 0;

    /// Opens `aPath` as document `aDocument` (chosen by the host). Fills
    /// aResponse.document on success, or aResponse.ok = false with an error.
    virtual void Open( uint32_t aDocument, const std::string& aPath,
                       triage::eda::v1::Response& aResponse ) = 0;

    /// Handles a request about one of this face's documents.
    virtual void Handle( const triage::eda::v1::Request& aRequest,
                         triage::eda::v1::Response& aResponse, const BULK_SINK& aBulk ) = 0;
};

} // namespace TRIAGE
