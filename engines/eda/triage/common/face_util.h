/*
 * Triage: helpers shared by the board and schematic engine faces. GPL-3.0-or-later.
 */

#pragma once

#include "engine_face.h"

#include "../stream_gal/display_list.h"
#include "../stream_gal/stream_gal.h"

#include <gal/color4d.h>
#include <math/box2.h>
#include <painter.h>
#include <view/view.h>

#include <triage/eda/v1/engine.pb.h>

#include <memory>
#include <string>

namespace TRIAGE
{

namespace pb = triage::eda::v1;

uint32_t PackColor( const KIGFX::COLOR4D& aColor );

void SetBox( pb::Box* aOut, const BOX2I& aBox );

/// Fails a response with a message.
void Fail( pb::Response& aResponse, const std::string& aMessage );

/**
 * Wraps a KiCad painter so the Stream GAL learns which item each cached group
 * belongs to and its level of detail. VIEW calls BeginGroup, then the painter's
 * Draw, then EndGroup (VIEW::updateItemGeometry).
 */
template <typename PAINTER_T>
class NOTING_PAINTER : public PAINTER_T
{
public:
    template <typename... ARGS>
    NOTING_PAINTER( STREAM_GAL* aGal, ARGS&&... aArgs ) :
            PAINTER_T( aGal, std::forward<ARGS>( aArgs )... ),
            m_streamGal( aGal )
    {
    }

    void SetView( KIGFX::VIEW* aView ) { m_view = aView; }

    bool Draw( const KIGFX::VIEW_ITEM* aItem, int aLayer ) override
    {
        const double lod = m_view ? aItem->ViewGetLOD( aLayer, m_view ) : 0.0;
        m_streamGal->NoteItem( dynamic_cast<const EDA_ITEM*>( aItem ), aLayer, lod );
        return PAINTER_T::Draw( aItem, aLayer );
    }

private:
    STREAM_GAL*  m_streamGal;
    KIGFX::VIEW* m_view = nullptr;
};

/**
 * Streams a view's display list: every live group (`aComplete`), or the groups
 * created, changed and deleted since the last call. Returns what was written.
 */
pb::DisplayListInfo StreamDisplayList( uint64_t aRequestId, uint32_t aDocument, STREAM_GAL& aGal,
                                       ITEM_INDEX& aItems, bool aComplete,
                                       const BULK_SINK& aBulk );

/// Milliseconds since `aStart` (a steady_clock time point in nanoseconds).
double MillisecondsSince( int64_t aStartNs );
int64_t NowNs();

} // namespace TRIAGE
