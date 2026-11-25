/*
 * Triage: the schematic engine face, compiled into KiCad's eeschema kiface
 * (ROADMAP P1-2, P1-3). GPL-3.0-or-later.
 *
 * Like the board face: what KiCad's schematic editor builds around its canvas,
 * without the window. A SCH_VIEW with the editor's layer setup (patch 0002),
 * KiCad's SCH_PAINTER with the render settings kicad-cli uses
 * (EESCHEMA_JOBS_HANDLER::InitRenderSettings), and the Stream GAL. The view
 * shows one sheet at a time, as the editor does.
 */

#include "sch_face.h"

#include "../common/face_util.h"

#include <connection_graph.h>
#include <drawing_sheet/ds_data_model.h>
#include <eeschema_helpers.h>
#include <eeschema_settings.h>
#include <filename_resolver.h>
#include <pgm_base.h>
#include <project.h>
#include <sch_collectors.h>
#include <sch_connection.h>
#include <sch_draw_panel.h>
#include <sch_label.h>
#include <sch_painter.h>
#include <sch_pin.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_symbol.h>
#include <sch_view.h>
#include <schematic.h>
#include <settings/color_settings.h>
#include <settings/settings_manager.h>

#include <wx/filename.h>

#include <algorithm>
#include <map>
#include <set>

namespace TRIAGE
{

SCH_DOC::~SCH_DOC()
{
    if( view )
        view->Clear();

    view.reset();
    painter.reset();
    gal.reset();
    undo.clear();
    redo.clear();
    schematic.reset();
}


bool SCH_FACE::Accepts( const std::string& aPath ) const
{
    return aPath.size() > 10 && aPath.compare( aPath.size() - 10, 10, ".kicad_sch" ) == 0;
}


SCH_DOC* SCH_FACE::doc( uint32_t aId, pb::Response& aResponse )
{
    auto it = m_docs.find( aId );

    if( it == m_docs.end() )
    {
        Fail( aResponse, "no schematic document " + std::to_string( aId ) );
        return nullptr;
    }

    return it->second.get();
}


void SCH_FACE::setupView( SCH_DOC& aDoc )
{
    SCHEMATIC* sch = aDoc.schematic.get();

    aDoc.gal = std::make_unique<STREAM_GAL>( aDoc.galOptions );
    aDoc.gal->SetWorldUnitLength( SCH_WORLD_UNIT );

    aDoc.painter = std::make_unique<NOTING_PAINTER<KIGFX::SCH_PAINTER>>( aDoc.gal.get() );
    aDoc.painter->SetSchematic( sch );

    aDoc.view = std::make_unique<KIGFX::SCH_VIEW>( nullptr );
    aDoc.view->SetGAL( aDoc.gal.get() );
    aDoc.view->SetPainter( aDoc.painter.get() );
    aDoc.painter->SetView( aDoc.view.get() );

    SchSetDefaultLayerOrder( aDoc.view.get() );
    SchSetDefaultLayerDeps( aDoc.view.get(), true );

    for( int i = 0; i < KIGFX::VIEW::VIEW_MAX_LAYERS; ++i )
        aDoc.view->SetLayerTarget( i, KIGFX::TARGET_CACHED );

    // EESCHEMA_JOBS_HANDLER::InitRenderSettings, with the user's colour theme.
    auto* rs = static_cast<SCH_RENDER_SETTINGS*>( aDoc.painter->GetSettings() );
    EESCHEMA_SETTINGS* cfg = GetAppSettings<EESCHEMA_SETTINGS>( "eeschema" );
    COLOR_SETTINGS*    cs = ::GetColorSettings( cfg ? cfg->m_ColorTheme : wxString( "_builtin_default" ) );

    if( cs )
        rs->LoadColors( cs );

    rs->m_ShowHiddenPins = false;
    rs->m_ShowHiddenFields = false;
    rs->m_ShowPinsElectricalType = false;
    rs->m_ShowPinAltIcons = false;
    rs->SetDefaultPenWidth( sch->Settings().m_DefaultLineWidth );
    rs->m_LabelSizeRatio = sch->Settings().m_LabelSizeRatio;
    rs->m_TextOffsetRatio = sch->Settings().m_TextOffsetRatio;
    rs->m_PinSymbolSize = sch->Settings().m_PinSymbolSize;
    rs->m_SymbolLineWidth = sch->Settings().m_DefaultLineWidth;
    rs->SetDashLengthRatio( sch->Settings().m_DashedLineDashRatio );
    rs->SetGapLengthRatio( sch->Settings().m_DashedLineGapRatio );

    FILENAME_RESOLVER resolve;
    resolve.SetProject( &sch->Project() );
    resolve.SetProgramBase( &Pgm() );
    wxString sheetFile = resolve.ResolvePath( sch->Settings().m_SchDrawingSheetFileName,
                                              wxGetCwd(), { sch->GetEmbeddedFiles() } );
    wxString msg;
    DS_DATA_MODEL::GetTheInstance().LoadDrawingSheet( sheetFile, &msg );

    aDoc.view->SetScale( 5.0 );
}


bool SCH_FACE::showSheet( SCH_DOC& aDoc, const std::string& aSheetPath )
{
    SCHEMATIC*     sch = aDoc.schematic.get();
    SCH_SHEET_LIST sheets = sch->Hierarchy();

    if( sheets.empty() )
        return false;

    SCH_SHEET_PATH target = sheets.front();

    if( !aSheetPath.empty() && aSheetPath != "/" )
    {
        bool found = false;

        for( const SCH_SHEET_PATH& path : sheets )
        {
            if( path.Path().AsString().ToStdString() == aSheetPath
                || path.PathAsString().ToStdString() == aSheetPath )
            {
                target = path;
                found = true;
                break;
            }
        }

        if( !found )
            return false;
    }

    // As SCH_EDIT_FRAME::SetCurrentSheet and SCH_DRAW_PANEL::DisplaySheet.
    aDoc.view->Clear();
    aDoc.gal->ClearCache();
    aDoc.sheet = target;
    sch->SetCurrentSheet( target );
    target.LastScreen()->SetVirtualPageNumber( target.GetVirtualPageNumber() );
    aDoc.view->DisplaySheet( target.LastScreen() );

    for( int i = 0; i < KIGFX::VIEW::VIEW_MAX_LAYERS; ++i )
        aDoc.view->SetLayerVisible( i, true );

    aDoc.view->UpdateItems();
    return true;
}


void SCH_FACE::fillInfo( SCH_DOC& aDoc, pb::DocumentInfo* aInfo )
{
    SCHEMATIC* sch = aDoc.schematic.get();
    auto*      rs = aDoc.painter->GetSettings();

    aInfo->set_document( aDoc.id );
    aInfo->set_kind( pb::DOCUMENT_KIND_SCHEMATIC );
    aInfo->set_path( aDoc.path );
    aInfo->set_iu_per_mm( schIUScale.IU_PER_MM );
    aInfo->set_background( PackColor( rs->GetBackgroundColor() ) );
    aInfo->set_modified( aDoc.modified );

    if( SCH_SCREEN* screen = aDoc.sheet.LastScreen() )
    {
        const VECTOR2I size = screen->GetPageSettings().GetSizeIU( schIUScale.IU_PER_MILS );
        SetBox( aInfo->mutable_bbox(), BOX2I( VECTOR2I( 0, 0 ), size ) );
    }

    std::set<int> layers;

    for( const auto& [id, group] : aDoc.gal->Groups() )
        layers.insert( group.layer );

    for( int layer : layers )
    {
        if( layer < 0 )
            continue;

        pb::Layer* out = aInfo->add_layers();
        out->set_id( layer );
        wxString name = LayerName( layer );
        out->set_name( name.IsEmpty() ? "Layer " + std::to_string( layer ) : name.ToStdString() );
        out->set_color( PackColor( rs->GetLayerColor( layer ) ) );
        out->set_order( aDoc.view->GetLayerOrder( layer ) );
        // As the schematic editor starts: no hidden fields and pins, no simulation
        // overlays, no selection shadows.
        out->set_visible( layer != LAYER_SELECTION_SHADOWS && layer != LAYER_OP_VOLTAGES
                          && layer != LAYER_OP_CURRENTS && layer != LAYER_HIDDEN );
        out->set_user( false );
        out->set_required( layer );
    }

    for( const SCH_SHEET_PATH& path : sch->Hierarchy() )
    {
        pb::Sheet* sheet = aInfo->add_sheets();
        sheet->set_path( path.Path().AsString().ToStdString() );
        sheet->set_name( path.size() <= 1 ? "Root"
                                          : path.Last()->GetName().ToStdString() );
        sheet->set_page( path.GetPageNumber().ToStdString() );

        if( SCH_SCREEN* screen = path.LastScreen() )
            sheet->set_file( screen->GetFileName().ToStdString() );
    }

    aInfo->set_pixels_per_iu_at_scale_1( aDoc.gal->GetWorldScale() / aDoc.view->GetScale() );
}


void SCH_FACE::Open( uint32_t aDocument, const std::string& aPath, pb::Response& aResponse )
{
    SCHEMATIC* sch = nullptr;

    try
    {
        sch = EESCHEMA_HELPERS::LoadSchematic( wxString::FromUTF8( aPath ), true, false );
    }
    catch( const IO_ERROR& error )
    {
        Fail( aResponse, "could not load " + aPath + ": " + error.What().ToStdString() );
        return;
    }

    if( !sch )
    {
        Fail( aResponse, "could not load " + aPath );
        return;
    }

    auto doc = std::make_unique<SCH_DOC>();
    doc->id = aDocument;
    doc->path = aPath;
    doc->schematic.reset( sch );
    setupView( *doc );

    if( !showSheet( *doc, "" ) )
    {
        Fail( aResponse, aPath + " has no sheets" );
        return;
    }

    fillInfo( *doc, aResponse.mutable_document() );
    aResponse.set_ok( true );
    m_docs[aDocument] = std::move( doc );
}


void SCH_FACE::fillItem( SCH_DOC& aDoc, const SCH_ITEM* aItem, pb::Item* aOut )
{
    aOut->set_uuid( aItem->m_Uuid.AsStdString() );
    aOut->set_type( aItem->GetClass().ToStdString() );
    aOut->set_description(
            aItem->GetItemDescription( aDoc.unitsProvider.get(), true ).ToStdString() );
    SetBox( aOut->mutable_bbox(), aItem->GetBoundingBox() );
    aOut->set_layer( aItem->GetLayer() );
    aOut->set_x( aItem->GetPosition().x );
    aOut->set_y( aItem->GetPosition().y );
    aOut->set_sheet( aDoc.sheet.Path().AsString().ToStdString() );

    if( const SCH_SYMBOL* symbol = dynamic_cast<const SCH_SYMBOL*>( aItem ) )
    {
        aOut->set_reference( symbol->GetRef( &aDoc.sheet, false ).ToStdString() );
        aOut->set_value( symbol->GetValue( true, &aDoc.sheet, false ).ToStdString() );
    }
    else if( const SCH_PIN* pin = dynamic_cast<const SCH_PIN*>( aItem ) )
    {
        if( const SCH_SYMBOL* parent = dynamic_cast<const SCH_SYMBOL*>( pin->GetParentSymbol() ) )
            aOut->set_reference( parent->GetRef( &aDoc.sheet, false ).ToStdString() );

        aOut->set_value( pin->GetNumber().ToStdString() );
    }

    if( SCH_CONNECTION* conn = aItem->Connection( &aDoc.sheet ) )
        aOut->set_net( conn->Name().ToStdString() );
}


SCH_ITEM* SCH_FACE::findItem( SCH_DOC& aDoc, const std::string& aUuid, SCH_SCREEN** aScreen )
{
    SCH_SHEET_PATH path;
    SCH_ITEM*      item = aDoc.schematic->ResolveItem( KIID( aUuid ), &path, true );

    if( aScreen )
        *aScreen = item ? path.LastScreen() : nullptr;

    return item;
}


void SCH_FACE::hitTest( SCH_DOC& aDoc, const pb::HitTest& aReq, pb::Response& aResponse )
{
    SCH_SCREEN*    screen = aDoc.sheet.LastScreen();
    const VECTOR2I pos( KiROUND( aReq.x() ), KiROUND( aReq.y() ) );

    SCH_COLLECTOR collector;
    collector.m_Threshold = std::max( 1, KiROUND( aReq.tolerance() ) );
    collector.Collect( screen, { SCH_LOCATE_ANY_T }, pos );

    std::vector<SCH_ITEM*> found;

    for( int i = 0; i < collector.GetCount(); ++i )
    {
        if( SCH_ITEM* item = dynamic_cast<SCH_ITEM*>( collector[i] ) )
            found.push_back( item );
    }

    std::stable_sort( found.begin(), found.end(),
                      []( const SCH_ITEM* a, const SCH_ITEM* b )
                      {
                          return a->GetBoundingBox().GetArea() < b->GetBoundingBox().GetArea();
                      } );

    pb::HitTestResult* result = aResponse.mutable_hit_test();

    for( SCH_ITEM* item : found )
        fillItem( aDoc, item, result->add_items() );

    aResponse.set_ok( true );
}


void SCH_FACE::setSelection( SCH_DOC& aDoc, const pb::SetSelection& aReq, pb::Response& aResponse,
                             uint64_t aRequestId, const BULK_SINK& aBulk )
{
    auto mark = [&]( SCH_ITEM* aItem, bool aSelected )
    {
        if( aSelected )
            aItem->SetSelected();
        else
            aItem->ClearSelected();

        aItem->RunOnChildren(
                [&]( SCH_ITEM* child )
                {
                    if( aSelected )
                        child->SetSelected();
                    else
                        child->ClearSelected();
                },
                RECURSE_MODE::RECURSE );

        aDoc.view->Update( aItem, KIGFX::REPAINT );
    };

    for( const KIID& id : aDoc.selection )
    {
        if( SCH_ITEM* item = aDoc.schematic->ResolveItem( id, nullptr, true ) )
            mark( item, false );
    }

    aDoc.selection.clear();

    for( const std::string& uuid : aReq.uuids() )
    {
        if( SCH_ITEM* item = findItem( aDoc, uuid ) )
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


void SCH_FACE::highlight( SCH_DOC& aDoc, const pb::Highlight& aReq, pb::Response& aResponse,
                          uint64_t aRequestId, const BULK_SINK& aBulk )
{
    // As SCH_EDITOR_CONTROL::UpdateNetHighlighting: brighten the items on the net.
    SCH_SCREEN* screen = aDoc.sheet.LastScreen();
    const wxString net = wxString::FromUTF8( aReq.net() );

    for( SCH_ITEM* item : screen->Items() )
    {
        bool on = false;

        if( !net.IsEmpty() )
        {
            if( SCH_CONNECTION* conn = item->Connection( &aDoc.sheet ) )
                on = conn->Name() == net;

            if( SCH_SYMBOL* symbol = dynamic_cast<SCH_SYMBOL*>( item ) )
            {
                for( SCH_PIN* pin : symbol->GetPins( &aDoc.sheet ) )
                {
                    SCH_CONNECTION* conn = pin->Connection( &aDoc.sheet );
                    const bool      pinOn = conn && conn->Name() == net;

                    if( pinOn )
                        pin->SetBrightened();
                    else
                        pin->ClearBrightened();
                }
            }
        }

        if( on )
            item->SetBrightened();
        else
            item->ClearBrightened();

        aDoc.view->Update( item, KIGFX::REPAINT );
    }

    aDoc.view->UpdateItems();
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void SCH_FACE::netlist( SCH_DOC& aDoc, pb::Response& aResponse )
{
    SCHEMATIC*   sch = aDoc.schematic.get();
    pb::Netlist* out = aResponse.mutable_netlist();

    std::map<std::string, pb::Component*> byRef;
    std::map<std::string, uint32_t>       netPins;

    for( const SCH_SHEET_PATH& path : sch->Hierarchy() )
    {
        for( SCH_ITEM* item : path.LastScreen()->Items().OfType( SCH_SYMBOL_T ) )
        {
            SCH_SYMBOL* symbol = static_cast<SCH_SYMBOL*>( item );

            const std::string ref = symbol->GetRef( &path, false ).ToStdString();

            // Power symbols and other virtual parts: their pins still name nets.
            const bool virtualPart = ref.empty() || ref[0] == '#';

            pb::Component* comp = nullptr;

            if( !virtualPart )
            {
                auto it = byRef.find( ref );

                if( it == byRef.end() )
                {
                    comp = out->add_components();
                    comp->set_reference( ref );
                    comp->set_value( symbol->GetValue( true, &path, false ).ToStdString() );
                    comp->set_footprint(
                            symbol->GetFootprintFieldText( true, &path, false ).ToStdString() );
                    comp->set_uuid( symbol->m_Uuid.AsStdString() );
                    comp->set_lib_id( symbol->GetLibId().GetUniStringLibId().ToStdString() );
                    comp->set_sheet( path.Path().AsString().ToStdString() );
                    byRef[ref] = comp;
                }
                else
                {
                    comp = it->second;
                }
            }

            for( SCH_PIN* pin : symbol->GetPins( &path ) )
            {
                SCH_CONNECTION* conn = pin->Connection( &path );
                const std::string net = conn ? conn->Name().ToStdString() : "";

                if( !net.empty() )
                    netPins[net]++;

                if( !comp )
                    continue;

                pb::Pin* outPin = comp->add_pins();
                outPin->set_number( pin->GetNumber().ToStdString() );
                outPin->set_name( pin->GetShownName().ToStdString() );
                outPin->set_type( pin->GetCanonicalElectricalTypeName().ToStdString() );
                outPin->set_net( net );
                outPin->set_uuid( pin->m_Uuid.AsStdString() );
            }
        }
    }

    int code = 1;

    for( const auto& [name, pins] : netPins )
    {
        pb::Net* net = out->add_nets();
        net->set_name( name );
        net->set_code( code++ );
        net->set_pins( pins );
    }

    aResponse.set_ok( true );
}


void SCH_FACE::getItems( SCH_DOC& aDoc, const pb::GetItems& aReq, pb::Response& aResponse )
{
    pb::Items* out = aResponse.mutable_items();

    for( const std::string& uuid : aReq.uuids() )
    {
        if( SCH_ITEM* item = findItem( aDoc, uuid ) )
            fillItem( aDoc, item, out->add_items() );
    }

    if( aReq.references_size() > 0 )
    {
        std::set<std::string> wanted( aReq.references().begin(), aReq.references().end() );

        for( const SCH_SHEET_PATH& path : aDoc.schematic->Hierarchy() )
        {
            for( SCH_ITEM* item : path.LastScreen()->Items().OfType( SCH_SYMBOL_T ) )
            {
                auto* symbol = static_cast<SCH_SYMBOL*>( item );

                if( wanted.count( symbol->GetRef( &path, false ).ToStdString() ) )
                {
                    pb::Item* outItem = out->add_items();
                    fillItem( aDoc, symbol, outItem );
                    outItem->set_reference( symbol->GetRef( &path, false ).ToStdString() );
                    outItem->set_sheet( path.Path().AsString().ToStdString() );
                }
            }
        }
    }

    aResponse.set_ok( true );
}


void SCH_FACE::Handle( const pb::Request& aRequest, pb::Response& aResponse,
                       const BULK_SINK& aBulk )
{
    switch( aRequest.command_case() )
    {
    case pb::Request::kCloseDocument:
        m_docs.erase( aRequest.close_document().document() );
        aResponse.set_ok( true );
        return;

    case pb::Request::kGetDisplayList:
        if( SCH_DOC* d = doc( aRequest.get_display_list().document(), aResponse ) )
        {
            const std::string& sheet = aRequest.get_display_list().sheet();
            const std::string  current = d->sheet.Path().AsString().ToStdString();

            if( !sheet.empty() && sheet != current && !showSheet( *d, sheet ) )
            {
                Fail( aResponse, "no sheet " + sheet );
                return;
            }

            d->view->UpdateItems();
            pb::DisplayListInfo info = StreamDisplayList( aRequest.id(), d->id, *d->gal, d->items,
                                                          true, aBulk );
            info.set_items( static_cast<uint32_t>( d->sheet.LastScreen()->Items().size() ) );
            *aResponse.mutable_display_list() = info;
            fillInfo( *d, aResponse.mutable_document_info() );
            aResponse.set_ok( true );
        }
        return;

    case pb::Request::kHitTest:
        if( SCH_DOC* d = doc( aRequest.hit_test().document(), aResponse ) )
            hitTest( *d, aRequest.hit_test(), aResponse );
        return;

    case pb::Request::kSetSelection:
        if( SCH_DOC* d = doc( aRequest.set_selection().document(), aResponse ) )
            setSelection( *d, aRequest.set_selection(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kHighlight:
        if( SCH_DOC* d = doc( aRequest.highlight().document(), aResponse ) )
            highlight( *d, aRequest.highlight(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kGetNetlist:
        if( SCH_DOC* d = doc( aRequest.get_netlist().document(), aResponse ) )
            netlist( *d, aResponse );
        return;

    case pb::Request::kGetItems:
        if( SCH_DOC* d = doc( aRequest.get_items().document(), aResponse ) )
            getItems( *d, aRequest.get_items(), aResponse );
        return;

    case pb::Request::kEdit:
        if( SCH_DOC* d = doc( aRequest.edit().document(), aResponse ) )
            edit( *d, aRequest.edit(), aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kUndo:
        if( SCH_DOC* d = doc( aRequest.undo().document(), aResponse ) )
            undoRedo( *d, true, aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kRedo:
        if( SCH_DOC* d = doc( aRequest.redo().document(), aResponse ) )
            undoRedo( *d, false, aResponse, aRequest.id(), aBulk );
        return;

    case pb::Request::kSave:
        if( SCH_DOC* d = doc( aRequest.save().document(), aResponse ) )
            save( *d, aRequest.save(), aResponse );
        return;

    case pb::Request::kReload:
        if( SCH_DOC* d = doc( aRequest.reload().document(), aResponse ) )
        {
            const uint32_t    id = d->id;
            const std::string path = d->path;
            m_docs.erase( id );
            Open( id, path, aResponse );
        }
        return;

    default:
        Fail( aResponse, "the schematic face does not handle this request" );
        return;
    }
}

} // namespace TRIAGE


static TRIAGE::SCH_FACE* s_schFace = nullptr;

// Patch 0001: eeschema's KIFACE returns this for KIFACE_TRIAGE_ENGINE.
void* TriageSchEngineFace()
{
    if( !s_schFace )
        s_schFace = new TRIAGE::SCH_FACE();

    return static_cast<TRIAGE::ENGINE_FACE*>( s_schFace );
}
