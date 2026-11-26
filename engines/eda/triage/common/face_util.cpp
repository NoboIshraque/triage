/*
 * Triage: helpers shared by the board and schematic engine faces. GPL-3.0-or-later.
 */

#include "face_util.h"

#include <algorithm>
#include <chrono>
#include <cmath>

namespace TRIAGE
{

uint32_t PackColor( const KIGFX::COLOR4D& aColor )
{
    auto channel = []( double v ) -> uint32_t
    {
        return static_cast<uint32_t>( std::clamp( std::lround( v * 255.0 ), 0L, 255L ) );
    };

    return ( channel( aColor.r ) << 24 ) | ( channel( aColor.g ) << 16 )
           | ( channel( aColor.b ) << 8 ) | channel( aColor.a );
}


void SetBox( pb::Box* aOut, const BOX2I& aBox )
{
    aOut->set_x0( aBox.GetLeft() );
    aOut->set_y0( aBox.GetTop() );
    aOut->set_x1( aBox.GetRight() );
    aOut->set_y1( aBox.GetBottom() );
}


void Fail( pb::Response& aResponse, const std::string& aMessage )
{
    aResponse.set_ok( false );
    aResponse.set_error( aMessage );
}


pb::DisplayListInfo StreamDisplayList( uint64_t aRequestId, uint32_t aDocument, STREAM_GAL& aGal,
                                       ITEM_INDEX& aItems, bool aComplete, const BULK_SINK& aBulk )
{
    const int64_t start = NowNs();

    std::set<int> changed;
    std::set<int> deleted;
    aGal.TakeChanges( changed, deleted );

    if( aComplete )
        aItems.Reset();

    DISPLAY_LIST_WRITER writer( aRequestId, aDocument, aComplete, aBulk );

    if( aComplete )
    {
        for( const auto& [id, group] : aGal.Groups() )
            writer.Group( group, aItems );
    }
    else
    {
        for( int id : deleted )
            writer.Delete( id );

        for( int id : changed )
        {
            if( const GROUP* group = aGal.Group( id ) )
                writer.Group( *group, aItems );
        }
    }

    writer.Finish();

    pb::DisplayListInfo info;
    info.set_document( aDocument );
    info.set_chunks( writer.Chunks() );
    info.set_bytes( writer.Bytes() );
    info.set_groups( writer.GroupsWritten() );
    info.set_milliseconds( MillisecondsSince( start ) );
    return info;
}


int64_t NowNs()
{
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
                   std::chrono::steady_clock::now().time_since_epoch() )
            .count();
}


double MillisecondsSince( int64_t aStartNs )
{
    return double( NowNs() - aStartNs ) / 1e6;
}

} // namespace TRIAGE
