/*
 * Triage: Stream GAL display-list encoding (ROADMAP P1-3). GPL-3.0-or-later.
 *
 * The binary format the engine streams to Triage's canvases, version 1. Every
 * field is 4 bytes, little-endian, so a client can view float runs in place.
 * The TypeScript reader is app/src/vs/triage/common/eda/displayList.ts.
 *
 * Chunk (the payload of one DisplayList frame, type 0x22):
 *   u64 request id (0: not an answer to a request)
 *   u32 magic 'TDL1' (0x314C4454)
 *   u32 document
 *   u32 flags: 1 = first chunk of a complete list (drop what you have),
 *              2 = last chunk of this list or update
 *   ops until the end of the chunk:
 *     u32 op = 1 GROUP   u32 id, i32 layer, i32 order, u32 item (index + 1, 0 = none),
 *                        f32 lod (visible while lod < VIEW scale), u32 flags (1 = colour
 *                        override), u32 override rgba, u32 run count, runs
 *     u32 op = 2 DELETE  u32 group id
 *     u32 op = 3 ITEM    u32 index, u32 byte length, UTF-8 KIID (padded to 4 bytes)
 *   run: u32 kind (1 triangles, 2 segments, 3 circles, 4 arcs, 5 image), u32 rgba,
 *        u32 float count, floats (see stream_gal.h for each kind's layout)
 */

#pragma once

#include "stream_gal.h"

#include <cstdint>
#include <functional>
#include <string>
#include <unordered_map>

namespace TRIAGE
{

inline constexpr uint32_t DISPLAY_LIST_MAGIC = 0x314C4454; // "TDL1"

enum DISPLAY_LIST_FLAGS : uint32_t
{
    DL_FIRST = 1,
    DL_LAST = 2,
};

/// Assigns compact indices to item UUIDs, per document.
class ITEM_INDEX
{
public:
    /// Index of `aUuid`, and whether it is new since the last Reset().
    uint32_t Get( const std::string& aUuid, bool& aIsNew );
    void     Reset() { m_index.clear(); }

private:
    std::unordered_map<std::string, uint32_t> m_index;
};


class DISPLAY_LIST_WRITER
{
public:
    using SINK = std::function<void( std::string&& aChunk )>;

    DISPLAY_LIST_WRITER( uint64_t aRequestId, uint32_t aDocument, bool aComplete, SINK aSink,
                         size_t aChunkBytes = 4 * 1024 * 1024 );

    void Group( const GROUP& aGroup, ITEM_INDEX& aItems );
    void Delete( int aGroupId );

    /// Writes the last chunk (also when nothing was written).
    void Finish();

    uint32_t Chunks() const { return m_chunks; }
    uint64_t Bytes() const { return m_bytes; }
    uint32_t GroupsWritten() const { return m_groups; }

private:
    void startChunk();
    void flush( bool aLast );
    void u32( uint32_t aValue );
    void i32( int32_t aValue ) { u32( static_cast<uint32_t>( aValue ) ); }
    void f32( float aValue );

    uint64_t    m_requestId;
    uint32_t    m_document;
    bool        m_complete;
    bool        m_first = true;
    SINK        m_sink;
    size_t      m_chunkBytes;
    std::string m_chunk;
    uint32_t    m_chunks = 0;
    uint64_t    m_bytes = 0;
    uint32_t    m_groups = 0;
};

} // namespace TRIAGE
