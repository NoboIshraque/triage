/*
 * Triage: KiCad's push-and-shove router hosted in the engine (ROADMAP P1-6 spike,
 * ADR 0004). GPL-3.0-or-later.
 *
 * KiCad's interactive router (PNS::ROUTER) talks to the board through a
 * ROUTER_IFACE. The board editor's adapter (PNS_KICAD_IFACE) needs a tool, a
 * frame and a BOARD_COMMIT; KiCad's own QA log player (qa/tools/pns) shows the
 * router also runs on PNS_KICAD_IFACE_BASE with just a BOARD. This file does the
 * same: TRIAGE_ROUTER_IFACE turns the router's added, removed and modified items
 * into board items and one engine change set (undoable like every edit).
 */

#include "pcb_face.h"

#include "../common/face_util.h"

#include <board.h>
#include <board_design_settings.h>
#include <netinfo.h>
#include <pad.h>
#include <pcb_track.h>
#include <pcb_view.h>
#include <router/pns_arc.h>
#include <router/pns_kicad_iface.h>
#include <router/pns_router.h>
#include <router/pns_routing_settings.h>
#include <router/pns_segment.h>
#include <router/pns_sizes_settings.h>
#include <router/pns_via.h>

#include <chrono>

namespace TRIAGE
{

namespace
{

class TRIAGE_ROUTER_IFACE : public PNS_KICAD_IFACE_BASE
{
public:
    explicit TRIAGE_ROUTER_IFACE( PCB_CHANGE_SET& aChanges ) : m_changes( aChanges ) {}

    void AddItem( PNS::ITEM* aItem ) override
    {
        BOARD_CONNECTED_ITEM* item = create( aItem );

        if( !item )
            return;

        aItem->SetParent( item );
        m_board->Add( item, ADD_MODE::APPEND );

        PCB_CHANGE change;
        change.kind = PCB_CHANGE::KIND::ADDED;
        change.item = item;
        m_changes.push_back( std::move( change ) );
        m_added++;
    }

    void RemoveItem( PNS::ITEM* aItem ) override
    {
        BOARD_ITEM* parent = aItem->Parent();

        // Pads stay: the router only moves footprints in its "drag" modes.
        if( !parent || parent->Type() == PCB_PAD_T )
            return;

        m_board->Remove( parent );

        PCB_CHANGE change;
        change.kind = PCB_CHANGE::KIND::REMOVED;
        change.owned.reset( parent );
        m_changes.push_back( std::move( change ) );
        m_removed.push_back( parent );
    }

    void UpdateItem( PNS::ITEM* aItem ) override
    {
        BOARD_ITEM* parent = aItem->Parent();

        if( !parent || !aItem->OfKind( PNS::ITEM::SEGMENT_T | PNS::ITEM::ARC_T | PNS::ITEM::VIA_T ) )
            return;

        PCB_CHANGE change;
        change.kind = PCB_CHANGE::KIND::CHANGED;
        change.item = parent;
        change.owned.reset( static_cast<BOARD_ITEM*>( parent->Clone() ) );
        m_changes.push_back( std::move( change ) );

        if( aItem->Kind() == PNS::ITEM::SEGMENT_T )
        {
            auto*      track = static_cast<PCB_TRACK*>( parent );
            const SEG& s = static_cast<PNS::SEGMENT*>( aItem )->Seg();
            track->SetStart( s.A );
            track->SetEnd( s.B );
            track->SetWidth( static_cast<PNS::SEGMENT*>( aItem )->Width() );
        }
        else if( aItem->Kind() == PNS::ITEM::VIA_T )
        {
            static_cast<PCB_VIA*>( parent )->SetPosition( static_cast<PNS::VIA*>( aItem )->Pos() );
        }
        else
        {
            auto*            arc = static_cast<PCB_ARC*>( parent );
            const SHAPE_ARC* shape = static_cast<const SHAPE_ARC*>( aItem->Shape( -1 ) );
            arc->SetStart( shape->GetP0() );
            arc->SetEnd( shape->GetP1() );
            arc->SetMid( shape->GetArcMid() );
        }
    }

    void Commit() override {}

    int GetNetCode( PNS::NET_HANDLE aNet ) const override
    {
        return aNet ? static_cast<NETINFO_ITEM*>( aNet )->GetNetCode() : -1;
    }

    wxString GetNetName( PNS::NET_HANDLE aNet ) const override
    {
        return aNet ? static_cast<NETINFO_ITEM*>( aNet )->GetNetname() : wxString();
    }

    uint32_t Added() const { return m_added; }
    uint32_t Removed() const { return static_cast<uint32_t>( m_removed.size() ); }

private:
    BOARD_CONNECTED_ITEM* create( PNS::ITEM* aItem )
    {
        NETINFO_ITEM* net = static_cast<NETINFO_ITEM*>( aItem->Net() );

        if( !net )
            net = NETINFO_LIST::OrphanedItem();

        switch( aItem->Kind() )
        {
        case PNS::ITEM::SEGMENT_T:
        {
            auto*      seg = static_cast<PNS::SEGMENT*>( aItem );
            auto*      track = new PCB_TRACK( m_board );
            const SEG& s = seg->Seg();
            track->SetStart( s.A );
            track->SetEnd( s.B );
            track->SetWidth( seg->Width() );
            track->SetLayer( GetBoardLayerFromPNSLayer( seg->Layers().Start() ) );
            track->SetNet( net );
            return track;
        }

        case PNS::ITEM::ARC_T:
        {
            auto* arc = static_cast<PNS::ARC*>( aItem );
            auto* boardArc = new PCB_ARC( m_board, static_cast<const SHAPE_ARC*>( arc->Shape( -1 ) ) );
            boardArc->SetWidth( arc->Width() );
            boardArc->SetLayer( GetBoardLayerFromPNSLayer( arc->Layers().Start() ) );
            boardArc->SetNet( net );
            return boardArc;
        }

        case PNS::ITEM::VIA_T:
        {
            auto* via = static_cast<PNS::VIA*>( aItem );
            auto* boardVia = new PCB_VIA( m_board );
            boardVia->SetPosition( via->Pos() );
            boardVia->SetWidth( PADSTACK::ALL_LAYERS, via->Diameter( 0 ) );
            boardVia->SetDrill( via->Drill() );
            boardVia->SetNet( net );
            boardVia->SetViaType( via->ViaType() );
            boardVia->SetLayerPair( GetBoardLayerFromPNSLayer( via->Layers().Start() ),
                                    GetBoardLayerFromPNSLayer( via->Layers().End() ) );
            return boardVia;
        }

        default:
            return nullptr;
        }
    }

    PCB_CHANGE_SET&          m_changes;
    uint32_t                 m_added = 0;
    std::vector<BOARD_ITEM*> m_removed;
};

double msSince( std::chrono::steady_clock::time_point aStart )
{
    return std::chrono::duration<double, std::milli>( std::chrono::steady_clock::now() - aStart )
            .count();
}

} // namespace


void PCB_FACE::route( PCB_DOC& aDoc, const pb::Route& aReq, pb::Response& aResponse,
                      uint64_t aRequestId, const BULK_SINK& aBulk )
{
    BOARD*         board = aDoc.board.get();
    PCB_CHANGE_SET changes;

    TRIAGE_ROUTER_IFACE iface( changes );
    iface.SetBoard( board );

    PNS::ROUTER router;
    router.SetInterface( &iface );
    router.ClearWorld();
    router.SyncWorld();

    PNS::ROUTING_SETTINGS settings( nullptr, "" );
    router.LoadSettings( &settings );
    router.SetMode( PNS::PNS_MODE_ROUTE_SINGLE );
    router.Settings().SetMode( aReq.shove() ? PNS::RM_Shove : PNS::RM_Walkaround );

    const VECTOR2I start( KiROUND( aReq.x() ), KiROUND( aReq.y() ) );

    // What's under the start point: the item the route continues from.
    PNS::ITEM*    startItem = nullptr;
    PNS::ITEM_SET hover = router.QueryHoverItems( start, pcbIUScale.mmToIU( 0.1 ) );

    for( PNS::ITEM* item : hover.Items() )
    {
        if( item->OfKind( PNS::ITEM::SOLID_T | PNS::ITEM::SEGMENT_T | PNS::ITEM::VIA_T | PNS::ITEM::ARC_T ) )
        {
            startItem = item;
            break;
        }
    }

    PCB_LAYER_ID layer = F_Cu;

    if( aReq.layer() >= 0 && aReq.layer() < PCB_LAYER_ID_COUNT && IsCopperLayer( aReq.layer() ) )
        layer = static_cast<PCB_LAYER_ID>( aReq.layer() );
    else if( startItem && startItem->Parent() && IsCopperLayer( startItem->Parent()->GetLayer() ) )
        layer = startItem->Parent()->GetLayer();

    int pnsLayer = iface.GetPNSLayerFromBoardLayer( layer );

    PNS::SIZES_SETTINGS sizes;
    iface.ImportSizes( sizes, startItem, startItem ? startItem->Net() : nullptr, start );
    router.UpdateSizes( sizes );

    if( !router.StartRouting( start, startItem, pnsLayer ) )
    {
        Fail( aResponse, "the router cannot start here: " + router.FailureReason().ToStdString() );
        return;
    }

    pb::RouteResult* result = aResponse.mutable_route();
    double           total = 0;
    double           worst = 0;
    VECTOR2I         last = start;

    for( int i = 0; i + 1 < aReq.moves_size(); i += 2 )
    {
        last = VECTOR2I( KiROUND( aReq.moves( i ) ), KiROUND( aReq.moves( i + 1 ) ) );
        const auto began = std::chrono::steady_clock::now();
        router.Move( last, nullptr );
        const double ms = msSince( began );
        total += ms;
        worst = std::max( worst, ms );
        result->set_moves( result->moves() + 1 );
    }

    if( result->moves() > 0 )
        result->set_average_ms( total / result->moves() );

    result->set_worst_ms( worst );
    result->set_mode( aReq.shove() ? "shove" : "walkaround" );

    if( aReq.commit() )
    {
        // As ROUTER_TOOL on a double click: fix the route at the cursor, then commit.
        router.FixRoute( last, nullptr, true, true );
        result->set_committed( true );
    }

    router.StopRouting();
    router.ClearWorld();
    result->set_added( iface.Added() );
    result->set_removed( iface.Removed() );

    for( PCB_CHANGE& change : changes )
    {
        if( change.kind == PCB_CHANGE::KIND::REMOVED && change.owned )
            aDoc.view->Remove( change.owned.get() );
    }

    pb::RouteResult saved = *result;
    commit( aDoc, std::move( changes ), aResponse, aRequestId, aBulk );
    *aResponse.mutable_route() = saved;
}

} // namespace TRIAGE
