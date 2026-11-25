/*
 * Triage: simple schematic edits through engine commits (ROADMAP P1-5, P1-6).
 * GPL-3.0-or-later.
 *
 * As on boards (pcb/pcb_edit.cpp): KiCad's SCH_COMMIT keeps its undo list in an
 * editor frame, so each Edit request becomes one change set on the engine's own
 * undo stack, made with KiCad's item operations (Move, Rotate, SwapItemData,
 * library loading, SCH_IO's saver).
 */

#include "sch_face.h"

#include "../common/face_util.h"

#include <connection_graph.h>
#include <libraries/symbol_library_adapter.h>
#include <project_sch.h>
#include <sch_io/sch_io.h>
#include <sch_io/sch_io_mgr.h>
#include <sch_label.h>
#include <sch_line.h>
#include <sch_painter.h>
#include <sch_screen.h>
#include <sch_sheet.h>
#include <sch_symbol.h>
#include <sch_view.h>
#include <schematic.h>

#include <wx/filename.h>

#include <cmath>
#include <set>

namespace TRIAGE
{

namespace
{

void snapshot( SCH_CHANGE_SET& aChanges, SCH_SCREEN* aScreen, SCH_ITEM* aItem )
{
    for( const SCH_CHANGE& change : aChanges )
    {
        if( change.item == aItem )
            return;
    }

    SCH_CHANGE change;
    change.kind = SCH_CHANGE::KIND::CHANGED;
    change.screen = aScreen;
    change.item = aItem;
    change.owned.reset( static_cast<SCH_ITEM*>( aItem->Clone() ) );
    aChanges.push_back( std::move( change ) );
}


/// The item the user means: a symbol for its pins and fields, a sheet for its pins.
SCH_ITEM* topLevel( SCH_ITEM* aItem )
{
    if( !aItem )
        return nullptr;

    if( aItem->Type() == SCH_PIN_T || aItem->Type() == SCH_FIELD_T || aItem->Type() == SCH_SHEET_PIN_T )
    {
        if( SCH_ITEM* parent = dynamic_cast<SCH_ITEM*>( aItem->GetParent() ) )
            return parent;
    }

    return aItem;
}

} // namespace


void SCH_FACE::refreshConnectivity( SCH_DOC& aDoc )
{
    aDoc.schematic->RefreshHierarchy();
    aDoc.schematic->RecalculateConnections( nullptr, NO_CLEANUP, nullptr );
    aDoc.view->UpdateItems();
}


void SCH_FACE::commit( SCH_DOC& aDoc, SCH_CHANGE_SET&& aChanges, pb::Response& aResponse,
                       uint64_t aRequestId, const BULK_SINK& aBulk )
{
    pb::EditResult* result = aResponse.mutable_edit();
    SCH_SCREEN*     shown = aDoc.sheet.LastScreen();

    for( SCH_CHANGE& change : aChanges )
    {
        SCH_ITEM* item = change.item ? change.item : change.owned.get();
        result->add_changed( item->m_Uuid.AsStdString() );

        if( change.screen != shown )
            continue;

        switch( change.kind )
        {
        case SCH_CHANGE::KIND::ADDED: aDoc.view->Add( change.item ); break;
        case SCH_CHANGE::KIND::REMOVED: break; // removed from the view before the screen
        case SCH_CHANGE::KIND::CHANGED: aDoc.view->Update( change.item ); break;
        }
    }

    refreshConnectivity( aDoc );

    // Connectivity changes how wires, junctions and dangling ends are drawn.
    aDoc.view->UpdateAllItems( KIGFX::REPAINT );
    aDoc.view->UpdateItems();

    if( !aChanges.empty() )
    {
        aDoc.undo.push_back( std::move( aChanges ) );
        aDoc.redo.clear();
        aDoc.modified = true;
    }

    result->set_modified( aDoc.modified );
    result->set_undo_depth( static_cast<uint32_t>( aDoc.undo.size() ) );
    result->set_redo_depth( static_cast<uint32_t>( aDoc.redo.size() ) );
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void SCH_FACE::edit( SCH_DOC& aDoc, const pb::Edit& aReq, pb::Response& aResponse,
                     uint64_t aRequestId, const BULK_SINK& aBulk )
{
    SCHEMATIC*     sch = aDoc.schematic.get();
    SCH_CHANGE_SET changes;

    auto items = [&]( const auto& aUuids )
    {
        std::vector<std::pair<SCH_SCREEN*, SCH_ITEM*>> out;

        for( const std::string& uuid : aUuids )
        {
            SCH_SCREEN* screen = nullptr;
            SCH_ITEM*   item = topLevel( findItem( aDoc, uuid, &screen ) );

            if( !item || !screen )
                continue;

            bool seen = false;

            for( const auto& [s, i] : out )
                seen |= i == item;

            if( !seen )
                out.emplace_back( screen, item );
        }

        return out;
    };

    // Schematic edits draw on the sheet the request names, or the shown one.
    auto sheetFor = [&]( const std::string& aSheet ) -> SCH_SHEET_PATH
    {
        if( !aSheet.empty() )
        {
            for( const SCH_SHEET_PATH& path : sch->Hierarchy() )
            {
                if( path.Path().AsString().ToStdString() == aSheet )
                    return path;
            }
        }

        return aDoc.sheet;
    };

    switch( aReq.action_case() )
    {
    case pb::Edit::kMove:
    {
        const VECTOR2I delta( KiROUND( aReq.move().dx() ), KiROUND( aReq.move().dy() ) );

        for( auto [screen, item] : items( aReq.move().uuids() ) )
        {
            snapshot( changes, screen, item );
            screen->Remove( item );
            item->Move( delta );
            screen->Append( item );
        }

        break;
    }

    case pb::Edit::kRotate:
    {
        auto  targets = items( aReq.rotate().uuids() );
        BOX2I box;

        for( auto [screen, item] : targets )
            box.Merge( item->GetBoundingBox() );

        // Schematics rotate in quarter turns (KiCad's SCH_ITEM::Rotate).
        int turns = static_cast<int>( std::lround( aReq.rotate().degrees() / 90.0 ) ) % 4;
        const bool ccw = turns > 0;
        turns = std::abs( turns );

        const VECTOR2I centre = targets.size() == 1 ? targets[0].second->GetPosition() : box.Centre();

        for( auto [screen, item] : targets )
        {
            snapshot( changes, screen, item );
            screen->Remove( item );

            for( int i = 0; i < turns; ++i )
                item->Rotate( centre, ccw );

            screen->Append( item );
        }

        break;
    }

    case pb::Edit::kDelete:
    {
        for( auto [screen, item] : items( aReq.delete_().uuids() ) )
        {
            if( screen == aDoc.sheet.LastScreen() )
                aDoc.view->Remove( item );

            screen->Remove( item );

            SCH_CHANGE change;
            change.kind = SCH_CHANGE::KIND::REMOVED;
            change.screen = screen;
            change.owned.reset( item );
            changes.push_back( std::move( change ) );
        }

        break;
    }

    case pb::Edit::kSetField:
    {
        const pb::SetField& req = aReq.set_field();
        SCH_SCREEN*         screen = nullptr;
        SCH_SYMBOL*         symbol =
                dynamic_cast<SCH_SYMBOL*>( topLevel( findItem( aDoc, req.uuid(), &screen ) ) );

        if( !symbol )
        {
            Fail( aResponse, "set_field needs a symbol" );
            return;
        }

        const wxString text = wxString::FromUTF8( req.text() );
        snapshot( changes, screen, symbol );

        if( req.field() == "Reference" )
        {
            // References are per sheet instance.
            symbol->SetRef( &aDoc.sheet, text );
        }
        else if( req.field() == "Value" )
        {
            symbol->SetValueFieldText( text, &aDoc.sheet );
        }
        else if( SCH_FIELD* field = symbol->GetField( wxString::FromUTF8( req.field() ) ) )
        {
            field->SetText( text );
        }
        else
        {
            changes.pop_back();
            Fail( aResponse, "symbol has no field " + req.field() );
            return;
        }

        break;
    }

    case pb::Edit::kPlaceSymbol:
    {
        const pb::PlaceSymbol& req = aReq.place_symbol();
        LIB_ID                 libId;

        if( libId.Parse( wxString::FromUTF8( req.lib_id() ) ) >= 0 || !libId.IsValid() )
        {
            Fail( aResponse, "not a library id: " + req.lib_id() );
            return;
        }

        SYMBOL_LIBRARY_ADAPTER* adapter = PROJECT_SCH::SymbolLibAdapter( &sch->Project() );
        LIB_SYMBOL*             libSymbol = nullptr;

        try
        {
            libSymbol = adapter ? adapter->LoadSymbol( libId ) : nullptr;
        }
        catch( const IO_ERROR& error )
        {
            Fail( aResponse, "could not load " + req.lib_id() + ": " + error.What().ToStdString() );
            return;
        }

        if( !libSymbol )
        {
            Fail( aResponse, "symbol " + req.lib_id() + " not found in the library tables" );
            return;
        }

        SCH_SHEET_PATH path = sheetFor( req.sheet() );
        const VECTOR2I pos( KiROUND( req.x() ), KiROUND( req.y() ) );
        auto*          symbol = new SCH_SYMBOL( *libSymbol, libId, &path, 1, 0, pos );

        if( !req.reference().empty() )
            symbol->SetRef( &path, wxString::FromUTF8( req.reference() ) );

        if( !req.value().empty() )
            symbol->SetValueFieldText( wxString::FromUTF8( req.value() ), &path );

        path.LastScreen()->Append( symbol );

        SCH_CHANGE change;
        change.kind = SCH_CHANGE::KIND::ADDED;
        change.screen = path.LastScreen();
        change.item = symbol;
        changes.push_back( std::move( change ) );
        break;
    }

    case pb::Edit::kAddWire:
    {
        const pb::AddWire& req = aReq.add_wire();

        if( req.points_size() < 4 || req.points_size() % 2 != 0 )
        {
            Fail( aResponse, "add_wire needs two or more points" );
            return;
        }

        SCH_SHEET_PATH path = sheetFor( req.sheet() );

        for( int i = 2; i + 1 < req.points_size(); i += 2 )
        {
            const VECTOR2I a( KiROUND( req.points( i - 2 ) ), KiROUND( req.points( i - 1 ) ) );
            const VECTOR2I b( KiROUND( req.points( i ) ), KiROUND( req.points( i + 1 ) ) );
            auto*          wire = new SCH_LINE( a, LAYER_WIRE );
            wire->SetEndPoint( b );
            path.LastScreen()->Append( wire );

            SCH_CHANGE change;
            change.kind = SCH_CHANGE::KIND::ADDED;
            change.screen = path.LastScreen();
            change.item = wire;
            changes.push_back( std::move( change ) );
        }

        break;
    }

    case pb::Edit::kRenameNet:
    {
        // A net's name comes from its labels: rename every label with the old name.
        const wxString from = wxString::FromUTF8( aReq.rename_net().from() );
        const wxString to = wxString::FromUTF8( aReq.rename_net().to() );
        std::set<SCH_SCREEN*> screens;

        for( const SCH_SHEET_PATH& path : sch->Hierarchy() )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !screens.insert( screen ).second )
                continue;

            for( SCH_ITEM* item : screen->Items() )
            {
                SCH_LABEL_BASE* label = dynamic_cast<SCH_LABEL_BASE*>( item );

                if( !label || label->GetText() != from )
                    continue;

                snapshot( changes, screen, label );
                label->SetText( to );
            }
        }

        if( changes.empty() )
        {
            Fail( aResponse, "no label names the net " + aReq.rename_net().from() );
            return;
        }

        break;
    }

    default:
        Fail( aResponse, "this edit is not available on schematics" );
        return;
    }

    commit( aDoc, std::move( changes ), aResponse, aRequestId, aBulk );
}


void SCH_FACE::undoRedo( SCH_DOC& aDoc, bool aUndo, pb::Response& aResponse, uint64_t aRequestId,
                         const BULK_SINK& aBulk )
{
    std::vector<SCH_CHANGE_SET>& from = aUndo ? aDoc.undo : aDoc.redo;
    std::vector<SCH_CHANGE_SET>& to = aUndo ? aDoc.redo : aDoc.undo;

    if( from.empty() )
    {
        Fail( aResponse, aUndo ? "nothing to undo" : "nothing to redo" );
        return;
    }

    SCH_CHANGE_SET  changes = std::move( from.back() );
    SCH_SCREEN*     shown = aDoc.sheet.LastScreen();
    pb::EditResult* result = aResponse.mutable_edit();
    from.pop_back();

    for( auto it = changes.rbegin(); it != changes.rend(); ++it )
    {
        SCH_CHANGE& change = *it;
        const bool  visible = change.screen == shown;

        switch( change.kind )
        {
        case SCH_CHANGE::KIND::ADDED:
            result->add_changed( change.item->m_Uuid.AsStdString() );

            if( visible )
                aDoc.view->Remove( change.item );

            change.screen->Remove( change.item );
            change.owned.reset( change.item );
            change.item = nullptr;
            change.kind = SCH_CHANGE::KIND::REMOVED;
            break;

        case SCH_CHANGE::KIND::REMOVED:
            result->add_changed( change.owned->m_Uuid.AsStdString() );
            change.item = change.owned.release();
            change.screen->Append( change.item );

            if( visible )
                aDoc.view->Add( change.item );

            change.kind = SCH_CHANGE::KIND::ADDED;
            break;

        case SCH_CHANGE::KIND::CHANGED:
            result->add_changed( change.item->m_Uuid.AsStdString() );

            if( visible )
                aDoc.view->Remove( change.item );

            change.screen->Remove( change.item );
            change.item->SwapItemData( change.owned.get() );
            change.screen->Append( change.item );

            if( visible )
                aDoc.view->Add( change.item );

            break;
        }
    }

    std::reverse( changes.begin(), changes.end() );
    to.push_back( std::move( changes ) );
    aDoc.modified = true;

    refreshConnectivity( aDoc );
    aDoc.view->UpdateAllItems( KIGFX::REPAINT );
    aDoc.view->UpdateItems();

    result->set_modified( aDoc.modified );
    result->set_undo_depth( static_cast<uint32_t>( aDoc.undo.size() ) );
    result->set_redo_depth( static_cast<uint32_t>( aDoc.redo.size() ) );
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void SCH_FACE::save( SCH_DOC& aDoc, const pb::Save& aReq, pb::Response& aResponse )
{
    SCHEMATIC* sch = aDoc.schematic.get();

    try
    {
        IO_RELEASER<SCH_IO>   pi( SCH_IO_MGR::FindPlugin( SCH_IO_MGR::SCH_KICAD ) );
        std::set<SCH_SCREEN*> saved;

        for( const SCH_SHEET_PATH& path : sch->Hierarchy() )
        {
            SCH_SCREEN* screen = path.LastScreen();

            if( !screen || !saved.insert( screen ).second )
                continue;

            wxString file = screen->GetFileName();

            // Save-as: the root sheet goes to the new path, sub-sheets stay beside it.
            if( !aReq.path().empty() && path.size() <= 1 )
                file = wxString::FromUTF8( aReq.path() );

            pi->SaveSchematicFile( file, path.Last(), sch );
        }
    }
    catch( const IO_ERROR& error )
    {
        Fail( aResponse, "could not save " + aDoc.path + ": " + error.What().ToStdString() );
        return;
    }

    if( aReq.path().empty() )
        aDoc.modified = false;

    aResponse.mutable_edit()->set_modified( aDoc.modified );
    aResponse.set_ok( true );
}

} // namespace TRIAGE
