/*
 * Triage: Stream GAL display-list encoding (ROADMAP P1-3). GPL-3.0-or-later.
 */

#include "display_list.h"

#include <cstring>
#include <limits>

namespace TRIAGE
{

uint32_t ITEM_INDEX::Get( const std::string& aUuid, bool& aIsNew )
{
    auto [it, inserted] = m_index.emplace( aUuid, static_cast<uint32_t>( m_index.size() ) );
    aIsNew = inserted;
    return it->second;
}


DISPLAY_LIST_WRITER::DISPLAY_LIST_WRITER( uint64_t aRequestId, uint32_t aDocument,
                                          bool aComplete, SINK aSink, size_t aChunkBytes ) :
        m_requestId( aRequestId ),
        m_document( aDocument ),
        m_complete( aComplete ),
        m_sink( std::move( aSink ) ),
        m_chunkBytes( aChunkBytes )
{
    startChunk();
}


void DISPLAY_LIST_WRITER::u32( uint32_t aValue )
{
    char bytes[4] = { char( aValue & 0xff ), char( ( aValue >> 8 ) & 0xff ),
                      char( ( aValue >> 16 ) & 0xff ), char( ( aValue >> 24 ) & 0xff ) };
    m_chunk.append( bytes, 4 );
}


void DISPLAY_LIST_WRITER::f32( float aValue )
{
    uint32_t bits;
    static_assert( sizeof( bits ) == sizeof( aValue ) );
    std::memcpy( &bits, &aValue, sizeof( bits ) );
    u32( bits );
}


void DISPLAY_LIST_WRITER::startChunk()
{
    m_chunk.clear();
    m_chunk.reserve( m_chunkBytes + 1024 );
    u32( static_cast<uint32_t>( m_requestId & 0xffffffffu ) );
    u32( static_cast<uint32_t>( m_requestId >> 32 ) );
    u32( DISPLAY_LIST_MAGIC );
    u32( m_document );
    u32( 0 ); // flags, patched in flush()
}


void DISPLAY_LIST_WRITER::flush( bool aLast )
{
    uint32_t flags = 0;

    if( m_first && m_complete )
        flags |= DL_FIRST;

    if( aLast )
        flags |= DL_LAST;

    for( int i = 0; i < 4; ++i )
        m_chunk[16 + i] = char( ( flags >> ( 8 * i ) ) & 0xff );

    m_first = false;
    m_chunks++;
    m_bytes += m_chunk.size();
    m_sink( std::move( m_chunk ) );
    startChunk();
}


void DISPLAY_LIST_WRITER::Group( const GROUP& aGroup, ITEM_INDEX& aItems )
{
    uint32_t itemRef = 0;

    if( !aGroup.uuid.empty() )
    {
        bool           isNew = false;
        const uint32_t index = aItems.Get( aGroup.uuid, isNew );

        if( isNew )
        {
            u32( 3 );
            u32( index );
            u32( static_cast<uint32_t>( aGroup.uuid.size() ) );
            m_chunk.append( aGroup.uuid );
            m_chunk.append( ( 4 - aGroup.uuid.size() % 4 ) % 4, '\0' );
        }

        itemRef = index + 1;
    }

    const float lod = aGroup.lod >= double( std::numeric_limits<float>::max() )
                              ? std::numeric_limits<float>::infinity()
                              : float( aGroup.lod );

    u32( 1 );
    u32( static_cast<uint32_t>( aGroup.id ) );
    i32( aGroup.layer );
    i32( aGroup.order );
    u32( itemRef );
    f32( lod );
    u32( aGroup.colorOverride ? 1u : 0u );
    u32( aGroup.overrideRgba );
    u32( static_cast<uint32_t>( aGroup.runs.size() ) );

    for( const PRIM_RUN& run : aGroup.runs )
    {
        u32( static_cast<uint32_t>( run.kind ) );
        u32( run.rgba );
        u32( static_cast<uint32_t>( run.data.size() ) );
        const size_t offset = m_chunk.size();
        m_chunk.resize( offset + run.data.size() * sizeof( float ) );
        std::memcpy( m_chunk.data() + offset, run.data.data(), run.data.size() * sizeof( float ) );
    }

    m_groups++;

    if( m_chunk.size() >= m_chunkBytes )
        flush( false );
}


void DISPLAY_LIST_WRITER::Delete( int aGroupId )
{
    u32( 2 );
    u32( static_cast<uint32_t>( aGroupId ) );

    if( m_chunk.size() >= m_chunkBytes )
        flush( false );
}


void DISPLAY_LIST_WRITER::Finish()
{
    flush( true );
}

} // namespace TRIAGE
