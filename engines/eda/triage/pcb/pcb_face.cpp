/*
 * Triage: the board engine face, compiled into KiCad's pcbnew kiface
 * (ROADMAP P1-2, P1-3, P1-6). GPL-3.0-or-later.
 *
 * Each open board gets what KiCad's board editor builds around its canvas, minus
 * the window: a PCB_VIEW with the editor's layer setup (patch 0002), KiCad's
 * PCB_PAINTER and, instead of the OpenGL GAL, the Stream GAL. Editing goes
 * through pcb_edit.cpp.
 */

#include "pcb_face.h"

#include "../common/face_util.h"

#include <board.h>
#include <board_design_settings.h>
#include <collectors.h>
#include <connectivity/connectivity_data.h>
#include <drawing_sheet/ds_proxy_view_item.h>
#include <footprint.h>
#include <pad.h>
#include <pcb_draw_panel_gal.h>
#include <pcb_display_options.h>
#include <pcb_board_outline.h>
#include <pcb_painter.h>
#include <pcb_track.h>
#include <pcb_view.h>
#include <pcbnew_settings.h>
#include <pgm_base.h>
#include <project.h>
#include <pcbnew_scripting_helpers.h>
#include <ratsnest/ratsnest_view_item.h>
#include <settings/color_settings.h>
#include <settings/settings_manager.h>
#include <string_utils.h>
#include <zone.h>

#include <wx/filename.h>

#include <algorithm>
#include <map>

namespace TRIAGE
{

PCB_DOC::~PCB_DOC()
{
    if( view )
        view->Clear();

    view.reset();
    painter.reset();
    gal.reset();
    ratsnest.reset();
    drawingSheet.reset();
    undo.clear();
    redo.clear();
    board.reset();
}


namespace
{

/// The board layer a GAL helper layer belongs to (ZONE_LAYER_FOR(F_Cu) -> F_Cu), or itself.
int baseLayer( int aLayer )
{
    if( aLayer >= LAYER_ZONE_START && aLayer < LAYER_ZONE_END )
        return aLayer - LAYER_ZONE_START;

    if( aLayer >= LAYER_PAD_COPPER_START && aLayer < LAYER_PAD_COPPER_END )
        return aLayer - LAYER_PAD_COPPER_START;

    if( aLayer >= LAYER_VIA_COPPER_START && aLayer < LAYER_VIA_COPPER_END )
        return aLayer - LAYER_VIA_COPPER_START;

    if( aLayer >= LAYER_CLEARANCE_START && aLayer < LAYER_CLEARANCE_END )
        return aLayer - LAYER_CLEARANCE_START;

    if( aLayer >= LAYER_POINT_START && aLayer < LAYER_POINT_END )
        return aLayer - LAYER_POINT_START;

    if( aLayer >= LAYER_BITMAP_START && aLayer < LAYER_BITMAP_END )
        return aLayer - LAYER_BITMAP_START;

    if( IsNetnameLayer( aLayer ) )
        return aLayer - NETNAMES_LAYER_ID_START;

    return aLayer;
}


bool layerVisible( BOARD* aBoard, int aLayer )
{
    const int base = baseLayer( aLayer );

    if( base >= 0 && base < PCB_LAYER_ID_COUNT )
    {
        const auto layer = static_cast<PCB_LAYER_ID>( base );
        return aBoard->IsLayerEnabled( layer ) && aBoard->IsLayerVisible( layer );
    }

    if( base >= GAL_LAYER_ID_START && base < GAL_LAYER_ID_END )
        return aBoard->IsElementVisible( static_cast<GAL_LAYER_ID>( base ) );

    return true;
}


std::string layerName( BOARD* aBoard, int aLayer )
{
    if( aLayer >= 0 && aLayer < PCB_LAYER_ID_COUNT )
        return aBoard->GetLayerName( static_cast<PCB_LAYER_ID>( aLayer ) ).ToStdString();

    wxString name = LayerName( aLayer );

    if( name.IsEmpty() )
        name = wxString::Format( wxS( "Layer %d" ), aLayer );

    return name.ToStdString();
}

} // namespace


bool PCB_FACE::Accepts( const std::string& aPath ) const
{
    return aPath.size() > 10 && aPath.compare( aPath.size() - 10, 10, ".kicad_pcb" ) == 0;
}


PCB_DOC* PCB_FACE::doc( uint32_t aId, pb::Response& aResponse )
{
    auto it = m_docs.find( aId );

    if( it == m_docs.end() )
    {
        Fail( aResponse, "no board document " + std::to_string( aId ) );
        return nullptr;
    }

    return it->second.get();
}


void PCB_FACE::setupView( PCB_DOC& aDoc )
{
    BOARD* board = aDoc.board.get();

    aDoc.gal = std::make_unique<STREAM_GAL>( aDoc.galOptions );
    aDoc.gal->SetWorldUnitLength( 1e-9 /* 1 nm */ / 0.0254 /* 1 inch in meters */ );

    aDoc.painter = std::make_unique<NOTING_PAINTER<KIGFX::PCB_PAINTER>>( aDoc.gal.get(),
                                                                          FRAME_PCB_EDITOR );
    aDoc.view = std::make_unique<KIGFX::PCB_VIEW>();
    aDoc.view->SetGAL( aDoc.gal.get() );
    aDoc.view->SetPainter( aDoc.painter.get() );
    aDoc.painter->SetView( aDoc.view.get() );

    PcbSetDefaultLayerOrder( aDoc.view.get() );
    // The board editor's targets, then every layer cached: the client composes
    // all of them on the GPU, so nothing is drawn immediate-mode.
    PcbSetDefaultLayerDeps( aDoc.view.get(), true );

    for( int i = 0; i < KIGFX::VIEW::VIEW_MAX_LAYERS; ++i )
        aDoc.view->SetLayerTarget( i, KIGFX::TARGET_CACHED );

    auto*            rs = static_cast<KIGFX::PCB_RENDER_SETTINGS*>( aDoc.painter->GetSettings() );
    PCBNEW_SETTINGS* cfg = GetAppSettings<PCBNEW_SETTINGS>( "pcbnew" );
    COLOR_SETTINGS*  cs = ::GetColorSettings( cfg ? cfg->m_ColorTheme : wxString( "_builtin_default" ) );

    if( cs )
        rs->LoadColors( cs );

    // The board editor's default display options (filled pads, tracks and zones).
    PCB_DISPLAY_OPTIONS options;
    aDoc.view->UpdateDisplayOptions( options );

    // A typical zoom (about 20 pixels per millimetre): a few painters size helper
    // marks in pixels.
    aDoc.view->SetScale( 5.0 );

    // What PCB_DRAW_PANEL_GAL::DisplayBoard adds.
    board->CacheTriangulation();

    for( BOARD_ITEM* item : board->GetItemSet() )
        aDoc.view->Add( item );

    board->UpdateBoardOutline();
    aDoc.view->Add( board->BoardOutline() );

    board->GetConnectivity()->RecalculateRatsnest();
    aDoc.ratsnest = std::make_unique<RATSNEST_VIEW_ITEM>( board->GetConnectivity() );
    aDoc.view->Add( aDoc.ratsnest.get() );

    aDoc.drawingSheet = std::make_unique<DS_PROXY_VIEW_ITEM>(
            pcbIUScale, &board->GetPageSettings(), board->GetProject(), &board->GetTitleBlock(),
            &board->GetProperties() );
    aDoc.drawingSheet->SetFileName( TO_UTF8( board->GetFileName() ) );
    aDoc.drawingSheet->SetColorLayer( LAYER_DRAWINGSHEET );
    aDoc.view->Add( aDoc.drawingSheet.get() );

    for( int i = 0; i < KIGFX::VIEW::VIEW_MAX_LAYERS; ++i )
        aDoc.view->SetLayerVisible( i, true );

    aDoc.view->UpdateItems();
}


void PCB_FACE::fillInfo( PCB_DOC& aDoc, pb::DocumentInfo* aInfo )
{
    BOARD* board = aDoc.board.get();
    auto*  rs = aDoc.painter->GetSettings();

    aInfo->set_document( aDoc.id );
    aInfo->set_kind( pb::DOCUMENT_KIND_BOARD );
    aInfo->set_path( aDoc.path );
    aInfo->set_iu_per_mm( pcbIUScale.IU_PER_MM );
    aInfo->set_background( PackColor( rs->GetBackgroundColor() ) );
    aInfo->set_modified( aDoc.modified );

    BOX2I bbox = board->GetBoardEdgesBoundingBox();

    if( bbox.GetWidth() == 0 || bbox.GetHeight() == 0 )
        bbox = board->GetBoundingBox();

    if( aDoc.drawingSheet )
        bbox.Merge( aDoc.drawingSheet->ViewBBox() );

    SetBox( aInfo->mutable_bbox(), bbox );

    std::set<int> layers;

    for( const auto& [id, group] : aDoc.gal->Groups() )
        layers.insert( group.layer );

    for( PCB_LAYER_ID layer : board->GetEnabledLayers() )
        layers.insert( layer );

    for( int layer : layers )
    {
        if( layer < 0 )
            continue;

        pb::Layer* out = aInfo->add_layers();
        out->set_id( layer );
        out->set_name( layerName( board, layer ) );
        out->set_color( PackColor( rs->GetLayerColor( layer ) ) );
        out->set_order( aDoc.view->GetLayerOrder( layer ) );
        out->set_visible( layerVisible( board, layer ) );
        out->set_user( layer < PCB_LAYER_ID_COUNT );
        out->set_required( baseLayer( layer ) );
    }

    // VIEW scale = pixels per world unit / (DPI x world unit length).
    aInfo->set_pixels_per_iu_at_scale_1( aDoc.gal->GetWorldScale() / aDoc.view->GetScale() );
}


void PCB_FACE::Open( uint32_t aDocument, const std::string& aPath, pb::Response& aResponse )
{
    wxString error;
    BOARD*   board = LoadBoard( wxString::FromUTF8( aPath ), true, &error );

    if( !board )
    {
        Fail( aResponse, "could not load " + aPath + ( error.IsEmpty() ? "" : ": " + error.ToStdString() ) );
        return;
    }

    auto doc = std::make_unique<PCB_DOC>();
    doc->id = aDocument;
    doc->path = aPath;
    doc->board.reset( board );
    setupView( *doc );
    fillInfo( *doc, aResponse.mutable_document() );
    aResponse.set_ok( true );
    m_docs[aDocument] = std::move( doc );
}


void PCB_FACE::fillItem( PCB_DOC& aDoc, const BOARD_ITEM* aItem, pb::Item* aOut )
{
    aOut->set_uuid( aItem->m_Uuid.AsStdString() );
    aOut->set_type( aItem->GetClass().ToStdString() );
    aOut->set_description( aItem->GetItemDescription( aDoc.unitsProvider.get(), true ).ToStdString() );
    SetBox( aOut->mutable_bbox(), aItem->GetBoundingBox() );
    aOut->set_layer( aItem->GetLayer() );
    aOut->set_x( aItem->GetPosition().x );
    aOut->set_y( aItem->GetPosition().y );

    if( const FOOTPRINT* fp = dynamic_cast<const FOOTPRINT*>( aItem ) )
    {
        aOut->set_reference( fp->GetReference().ToStdString() );
        aOut->set_value( fp->GetValue().ToStdString() );
        aOut->set_angle( fp->GetOrientation().AsDegrees() );
    }
    else if( const BOARD_CONNECTED_ITEM* conn = dynamic_cast<const BOARD_CONNECTED_ITEM*>( aItem ) )
    {
        aOut->set_net( conn->GetNetname().ToStdString() );

        if( const PAD* pad = dynamic_cast<const PAD*>( aItem ) )
        {
            if( const FOOTPRINT* parent = pad->GetParentFootprint() )
                aOut->set_reference( parent->GetReference().ToStdString() );

            aOut->set_value( pad->GetNumber().ToStdString() );
        }
    }
}


BOARD_ITEM* PCB_FACE::findItem( PCB_DOC& aDoc, const std::string& aUuid )
{
    const KIID id( aUuid );
    return aDoc.board->ResolveItem( id, true );
}


void PCB_FACE::hitTest( PCB_DOC& aDoc, const pb::HitTest& aReq, pb::Response& aResponse )
{
    BOARD*   board = aDoc.board.get();
    VECTOR2I pos( KiROUND( aReq.x() ), KiROUND( aReq.y() ) );

    LSET visible = board->GetVisibleLayers() & board->GetEnabledLayers();

    if( aReq.layers_size() > 0 )
    {
        visible = LSET();

        for( int layer : aReq.layers() )
        {
            if( layer >= 0 && layer < PCB_LAYER_ID_COUNT )
                visible.set( layer );
        }
    }

    GENERAL_COLLECTORS_GUIDE guide( visible, F_Cu, aDoc.view.get() );
    guide.SetAccuracy( std::max( 1, KiROUND( aReq.tolerance() ) ) );
    guide.SetIgnoreZoneFills( false );

    GENERAL_COLLECTOR collector;
    collector.Collect( board, GENERAL_COLLECTOR::AllBoardItems, pos, guide );

    std::vector<BOARD_ITEM*> found;

    for( int i = 0; i < collector.GetCount(); ++i )
        found.push_back( collector[i] );

    // Smallest first: a pad before its footprint, a via before the zone it sits in.
    std::stable_sort( found.begin(), found.end(),
                      []( const BOARD_ITEM* a, const BOARD_ITEM* b )
                      {
                          return a->GetBoundingBox().GetArea() < b->GetBoundingBox().GetArea();
                      } );

    pb::HitTestResult* result = aResponse.mutable_hit_test();

    for( BOARD_ITEM* item : found )
        fillItem( aDoc, item, result->add_items() );

    aResponse.set_ok( true );
}


void PCB_FACE::setSelection( PCB_DOC& aDoc, const pb::SetSelection& aReq, pb::Response& aResponse,
                             uint64_t aRequestId, const BULK_SINK& aBulk )
{
    auto mark = [&]( BOARD_ITEM* aItem, bool aSelected )
    {
        if( aSelected )
            aItem->SetSelected();
        else
            aItem->ClearSelected();

        if( FOOTPRINT* fp = dynamic_cast<FOOTPRINT*>( aItem ) )
        {
            fp->RunOnChildren(
                    [&]( BOARD_ITEM* child )
                    {
                        if( aSelected )
                            child->SetSelected();
                        else
                            child->ClearSelected();

                        aDoc.view->Update( child, KIGFX::REPAINT );
                    },
                    RECURSE_MODE::RECURSE );
        }

        aDoc.view->Update( aItem, KIGFX::REPAINT );
    };

    for( const KIID& id : aDoc.selection )
    {
        if( BOARD_ITEM* item = aDoc.board->ResolveItem( id, true ) )
            mark( item, false );
    }

    aDoc.selection.clear();

    for( const std::string& uuid : aReq.uuids() )
    {
        if( BOARD_ITEM* item = findItem( aDoc, uuid ) )
        {
            mark( item, true );
            aDoc.selection.push_back( item->m_Uuid );
        }
    }

    aDoc.view->UpdateItems();
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void PCB_FACE::highlight( PCB_DOC& aDoc, const pb::Highlight& aReq, pb::Response& aResponse,
                          uint64_t aRequestId, const BULK_SINK& aBulk )
{
    auto* rs = static_cast<KIGFX::PCB_RENDER_SETTINGS*>( aDoc.painter->GetSettings() );
    int   netCode = -1;

    if( !aReq.net().empty() )
    {
        if( NETINFO_ITEM* net = aDoc.board->FindNet( wxString::FromUTF8( aReq.net() ) ) )
            netCode = net->GetNetCode();
    }

    rs->SetHighlight( netCode >= 0, netCode );
    aDoc.view->UpdateAllItems( KIGFX::REPAINT );
    aDoc.view->UpdateItems();
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void PCB_FACE::netlist( PCB_DOC& aDoc, pb::Response& aResponse )
{
    BOARD*       board = aDoc.board.get();
    pb::Netlist* out = aResponse.mutable_netlist();

    for( FOOTPRINT* fp : board->Footprints() )
    {
        pb::Component* comp = out->add_components();
        comp->set_reference( fp->GetReference().ToStdString() );
        comp->set_value( fp->GetValue().ToStdString() );
        comp->set_footprint( fp->GetFPID().GetUniStringLibId().ToStdString() );
        comp->set_uuid( fp->m_Uuid.AsStdString() );

        for( PAD* pad : fp->Pads() )
        {
            pb::Pin* pin = comp->add_pins();
            pin->set_number( pad->GetNumber().ToStdString() );
            pin->set_name( pad->GetPinFunction().ToStdString() );
            pin->set_type( pad->GetPinType().ToStdString() );
            pin->set_net( pad->GetNetname().ToStdString() );
            pin->set_uuid( pad->m_Uuid.AsStdString() );
        }
    }

    std::map<int, uint32_t> pinCounts;

    for( FOOTPRINT* fp : board->Footprints() )
    {
        for( PAD* pad : fp->Pads() )
            pinCounts[pad->GetNetCode()]++;
    }

    for( NETINFO_ITEM* net : board->GetNetInfo() )
    {
        if( net->GetNetCode() <= 0 )
            continue;

        pb::Net* outNet = out->add_nets();
        outNet->set_name( net->GetNetname().ToStdString() );
        outNet->set_code( net->GetNetCode() );
        outNet->set_pins( pinCounts[net->GetNetCode()] );
    }

    aResponse.set_ok( true );
}


void PCB_FACE::getItems( PCB_DOC& aDoc, const pb::GetItems& aReq, pb::Response& aResponse )
{
    pb::Items* out = aResponse.mutable_items();

    for( const std::string& uuid : aReq.uuids() )
    {
        if( BOARD_ITEM* item = findItem( aDoc, uuid ) )
            fillItem( aDoc, item, out->add_items() );
    }

    for( const std::string& ref : aReq.references() )
    {
        if( FOOTPRINT* fp = aDoc.board->FindFootprintByReference( wxString::FromUTF8( ref ) ) )
            fillItem( aDoc, fp, out->add_items() );
    }

    aResponse.set_ok( true );
}


void PCB_FACE::Handle( const pb::Request& aRequest, pb::Response& aResponse,
                       const BULK_SINK& aBulk )
{
    switch( aRequest.command_case() )
    {
    case pb::Request::kCloseDocument:
        m_docs.erase( aRequest.close_document().document() );
        aResponse.set_ok( true );
        return;

    case pb::Request::kGetDisplayList:
        if( PCB_DOC* d = doc( aRequest.get_display_list().document(), aResponse ) )
        {
            d->view->UpdateItems();
            pb::DisplayListInfo info = StreamDisplayList( aRequest.id(), d->id, *d->gal, d->items,
                                                          true, aBulk );
            info.set_items( static_cast<uint32_t>( d->board->GetItemSet().size() ) );
            *aResponse.mutable_display_list() = info;
            aResponse.set_ok( true );
        }
        return;

    case pb::Request::kHitTest:
        if( PCB_DOC* d = doc( aRequest.hit_test().document(), aResponse ) )
            hitTest( *d, aRequest.hit_test(), aResponse );
        return;

    case pb::Request::kSetSelection:
        if( PCB_DOC* d = doc( aRequest.set_selection().document(), aResponse ) )
            setSelection( *d, aRequest.set_selection(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kHighlight:
        if( PCB_DOC* d = doc( aRequest.highlight().document(), aResponse ) )
            highlight( *d, aRequest.highlight(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kGetNetlist:
        if( PCB_DOC* d = doc( aRequest.get_netlist().document(), aResponse ) )
            netlist( *d, aResponse );
        return;

    case pb::Request::kGetItems:
        if( PCB_DOC* d = doc( aRequest.get_items().document(), aResponse ) )
            getItems( *d, aRequest.get_items(), aResponse );
        return;

    case pb::Request::kEdit:
        if( PCB_DOC* d = doc( aRequest.edit().document(), aResponse ) )
            edit( *d, aRequest.edit(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kUndo:
        if( PCB_DOC* d = doc( aRequest.undo().document(), aResponse ) )
            undoRedo( *d, true, aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kRedo:
        if( PCB_DOC* d = doc( aRequest.redo().document(), aResponse ) )
            undoRedo( *d, false, aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kSave:
        if( PCB_DOC* d = doc( aRequest.save().document(), aResponse ) )
            save( *d, aRequest.save(), aResponse );
        return;

    case pb::Request::kReload:
        if( PCB_DOC* d = doc( aRequest.reload().document(), aResponse ) )
        {
            const uint32_t    id = d->id;
            const std::string path = d->path;
            m_docs.erase( id );
            Open( id, path, aResponse );
        }
        return;

    default:
        Fail( aResponse, "the board face does not handle this request" );
        return;
    }
}

} // namespace TRIAGE


static TRIAGE::PCB_FACE* s_pcbFace = nullptr;

// Patch 0001: pcbnew's KIFACE returns this for KIFACE_TRIAGE_ENGINE.
void* TriagePcbEngineFace()
{
    if( !s_pcbFace )
        s_pcbFace = new TRIAGE::PCB_FACE();

    return static_cast<TRIAGE::ENGINE_FACE*>( s_pcbFace );
}
