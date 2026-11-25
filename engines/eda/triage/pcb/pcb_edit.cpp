/*
 * Triage: simple board edits through engine commits (ROADMAP P1-6). GPL-3.0-or-later.
 *
 * Each Edit request becomes one change set on the document's undo stack, made
 * with KiCad's own item operations (Move, Rotate, SwapItemData, library
 * loading). KiCad's BOARD_COMMIT needs an editor frame for its undo list, so the
 * engine keeps its own: a CHANGED entry holds the other state of the item and
 * undo swaps it in, as KiCad's undo does (PICKED_ITEMS_LIST, SwapItemData).
 */

#include "pcb_face.h"

#include "../common/face_util.h"

#include <board.h>
#include <board_design_settings.h>
#include <connectivity/connectivity_data.h>
#include <footprint.h>
#include <footprint_library_adapter.h>
#include <pad.h>
#include <pcb_field.h>
#include <pcb_painter.h>
#include <pcb_track.h>
#include <pcb_view.h>
#include <project_pcb.h>
#include <pcbnew_scripting_helpers.h>
#include <ratsnest/ratsnest_view_item.h>

#include <wx/filename.h>

namespace TRIAGE
{

namespace
{

/// Records `aItem`'s state before a change (once per item and change set).
void snapshot( PCB_CHANGE_SET& aChanges, BOARD_ITEM* aItem )
{
    for( const PCB_CHANGE& change : aChanges )
    {
        if( change.item == aItem )
            return;
    }

    PCB_CHANGE change;
    change.kind = PCB_CHANGE::KIND::CHANGED;
    change.item = aItem;
    change.owned.reset( static_cast<BOARD_ITEM*>( aItem->Clone() ) );
    aChanges.push_back( std::move( change ) );
}


/// The item the user means: a footprint for any of its children (pads, fields).
BOARD_ITEM* topLevel( BOARD_ITEM* aItem )
{
    if( !aItem )
        return nullptr;

    if( FOOTPRINT* fp = aItem->GetParentFootprint() )
        return fp;

    return aItem;
}

} // namespace


void PCB_FACE::refreshConnectivity( PCB_DOC& aDoc )
{
    // As PCB_BASE_FRAME::Compile_Ratsnest after a change.
    aDoc.board->BuildConnectivity();
    aDoc.board->GetConnectivity()->RecalculateRatsnest();
    aDoc.board->UpdateRatsnestExclusions();

    if( aDoc.ratsnest )
        aDoc.view->Update( aDoc.ratsnest.get() );

    aDoc.view->UpdateItems();
}


void PCB_FACE::commit( PCB_DOC& aDoc, PCB_CHANGE_SET&& aChanges, pb::Response& aResponse,
                       uint64_t aRequestId, const BULK_SINK& aBulk )
{
    pb::EditResult* result = aResponse.mutable_edit();

    for( PCB_CHANGE& change : aChanges )
    {
        BOARD_ITEM* item = change.item ? change.item : change.owned.get();
        result->add_changed( item->m_Uuid.AsStdString() );

        switch( change.kind )
        {
        case PCB_CHANGE::KIND::ADDED: aDoc.view->Add( change.item ); break;
        case PCB_CHANGE::KIND::REMOVED: break; // removed from the view before the board
        case PCB_CHANGE::KIND::CHANGED: aDoc.view->Update( change.item ); break;
        }
    }

    refreshConnectivity( aDoc );

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


void PCB_FACE::edit( PCB_DOC& aDoc, const pb::Edit& aReq, pb::Response& aResponse,
                     uint64_t aRequestId, const BULK_SINK& aBulk )
{
    BOARD*         board = aDoc.board.get();
    PCB_CHANGE_SET changes;

    auto items = [&]( const auto& aUuids )
    {
        std::vector<BOARD_ITEM*> out;

        for( const std::string& uuid : aUuids )
        {
            BOARD_ITEM* item = topLevel( findItem( aDoc, uuid ) );

            if( item && std::find( out.begin(), out.end(), item ) == out.end() )
                out.push_back( item );
        }

        return out;
    };

    switch( aReq.action_case() )
    {
    case pb::Edit::kMove:
    {
        const VECTOR2I delta( KiROUND( aReq.move().dx() ), KiROUND( aReq.move().dy() ) );

        for( BOARD_ITEM* item : items( aReq.move().uuids() ) )
        {
            snapshot( changes, item );
            item->Move( delta );
        }

        break;
    }

    case pb::Edit::kRotate:
    {
        std::vector<BOARD_ITEM*> targets = items( aReq.rotate().uuids() );
        BOX2I                    box;

        for( BOARD_ITEM* item : targets )
            box.Merge( item->GetBoundingBox() );

        // KiCad's angles are counter-clockwise on screen (y points down).
        const EDA_ANGLE angle( aReq.rotate().degrees(), DEGREES_T );
        const VECTOR2I  centre = targets.size() == 1 ? targets[0]->GetPosition() : box.Centre();

        for( BOARD_ITEM* item : targets )
        {
            snapshot( changes, item );
            item->Rotate( centre, angle );
        }

        break;
    }

    case pb::Edit::kDelete:
    {
        for( BOARD_ITEM* item : items( aReq.delete_().uuids() ) )
        {
            aDoc.view->Remove( item );
            board->Remove( item );

            PCB_CHANGE change;
            change.kind = PCB_CHANGE::KIND::REMOVED;
            change.owned.reset( item );
            changes.push_back( std::move( change ) );
        }

        break;
    }

    case pb::Edit::kSetField:
    {
        const pb::SetField& req = aReq.set_field();
        FOOTPRINT*          fp = dynamic_cast<FOOTPRINT*>( topLevel( findItem( aDoc, req.uuid() ) ) );

        if( !fp )
        {
            Fail( aResponse, "set_field needs a footprint" );
            return;
        }

        PCB_FIELD* field = fp->GetField( wxString::FromUTF8( req.field() ) );

        if( !field )
        {
            Fail( aResponse, "footprint " + fp->GetReference().ToStdString() + " has no field "
                                     + req.field() );
            return;
        }

        snapshot( changes, fp );
        field->SetText( wxString::FromUTF8( req.text() ) );
        break;
    }

    case pb::Edit::kPlaceFootprint:
    {
        const pb::PlaceFootprint& req = aReq.place_footprint();
        LIB_ID                    libId;

        if( libId.Parse( wxString::FromUTF8( req.lib_id() ) ) >= 0 || !libId.IsValid() )
        {
            Fail( aResponse, "not a library id: " + req.lib_id() );
            return;
        }

        FOOTPRINT_LIBRARY_ADAPTER* adapter = PROJECT_PCB::FootprintLibAdapter( board->GetProject() );
        FOOTPRINT*                 fp = nullptr;

        try
        {
            fp = adapter ? adapter->LoadFootprint( libId, false ) : nullptr;
        }
        catch( const IO_ERROR& error )
        {
            Fail( aResponse, "could not load " + req.lib_id() + ": " + error.What().ToStdString() );
            return;
        }

        if( !fp )
        {
            Fail( aResponse, "footprint " + req.lib_id() + " not found in the library tables" );
            return;
        }

        fp->SetParent( board );
        fp->SetFPID( libId );

        if( !req.reference().empty() )
            fp->SetReference( wxString::FromUTF8( req.reference() ) );

        if( !req.value().empty() )
            fp->SetValue( wxString::FromUTF8( req.value() ) );

        fp->SetPosition( VECTOR2I( KiROUND( req.x() ), KiROUND( req.y() ) ) );

        if( req.back() )
            fp->Flip( fp->GetPosition(), FLIP_DIRECTION::LEFT_RIGHT );

        board->Add( fp, ADD_MODE::APPEND );

        PCB_CHANGE change;
        change.kind = PCB_CHANGE::KIND::ADDED;
        change.item = fp;
        changes.push_back( std::move( change ) );
        break;
    }

    case pb::Edit::kAddTrack:
    {
        const pb::AddTrack& req = aReq.add_track();

        if( req.points_size() < 4 || req.points_size() % 2 != 0 )
        {
            Fail( aResponse, "add_track needs two or more points" );
            return;
        }

        const PCB_LAYER_ID layer = req.layer() >= 0 && req.layer() < PCB_LAYER_ID_COUNT
                                           && IsCopperLayer( req.layer() )
                                           ? static_cast<PCB_LAYER_ID>( req.layer() )
                                           : F_Cu;
        NETINFO_ITEM*      net = nullptr;

        if( !req.net().empty() )
            net = board->FindNet( wxString::FromUTF8( req.net() ) );

        int width = KiROUND( req.width() );

        if( width <= 0 )
            width = board->GetDesignSettings().GetCurrentTrackWidth();

        for( int i = 2; i + 1 < req.points_size(); i += 2 )
        {
            auto* track = new PCB_TRACK( board );
            track->SetStart( VECTOR2I( KiROUND( req.points( i - 2 ) ), KiROUND( req.points( i - 1 ) ) ) );
            track->SetEnd( VECTOR2I( KiROUND( req.points( i ) ), KiROUND( req.points( i + 1 ) ) ) );
            track->SetWidth( width );
            track->SetLayer( layer );

            if( net )
                track->SetNet( net );

            board->Add( track, ADD_MODE::APPEND );

            PCB_CHANGE change;
            change.kind = PCB_CHANGE::KIND::ADDED;
            change.item = track;
            changes.push_back( std::move( change ) );
        }

        break;
    }

    default:
        Fail( aResponse, "this edit is not available on boards yet" );
        return;
    }

    commit( aDoc, std::move( changes ), aResponse, aRequestId, aBulk );
}


void PCB_FACE::undoRedo( PCB_DOC& aDoc, bool aUndo, pb::Response& aResponse, uint64_t aRequestId,
                         const BULK_SINK& aBulk )
{
    std::vector<PCB_CHANGE_SET>& from = aUndo ? aDoc.undo : aDoc.redo;
    std::vector<PCB_CHANGE_SET>& to = aUndo ? aDoc.redo : aDoc.undo;

    if( from.empty() )
    {
        Fail( aResponse, aUndo ? "nothing to undo" : "nothing to redo" );
        return;
    }

    PCB_CHANGE_SET changes = std::move( from.back() );
    from.pop_back();

    pb::EditResult* result = aResponse.mutable_edit();

    // Undo in reverse order; each entry turns into its own inverse.
    for( auto it = changes.rbegin(); it != changes.rend(); ++it )
    {
        PCB_CHANGE& change = *it;

        switch( change.kind )
        {
        case PCB_CHANGE::KIND::ADDED:
            result->add_changed( change.item->m_Uuid.AsStdString() );
            aDoc.view->Remove( change.item );
            aDoc.board->Remove( change.item );
            change.owned.reset( change.item );
            change.item = nullptr;
            change.kind = PCB_CHANGE::KIND::REMOVED;
            break;

        case PCB_CHANGE::KIND::REMOVED:
            result->add_changed( change.owned->m_Uuid.AsStdString() );
            change.item = change.owned.release();
            aDoc.board->Add( change.item, ADD_MODE::APPEND );
            aDoc.view->Add( change.item );
            change.kind = PCB_CHANGE::KIND::ADDED;
            break;

        case PCB_CHANGE::KIND::CHANGED:
            result->add_changed( change.item->m_Uuid.AsStdString() );
            aDoc.view->Remove( change.item );
            change.item->SwapItemData( change.owned.get() );
            aDoc.view->Add( change.item );
            break;
        }
    }

    std::reverse( changes.begin(), changes.end() );
    to.push_back( std::move( changes ) );
    aDoc.modified = true;

    refreshConnectivity( aDoc );

    result->set_modified( aDoc.modified );
    result->set_undo_depth( static_cast<uint32_t>( aDoc.undo.size() ) );
    result->set_redo_depth( static_cast<uint32_t>( aDoc.redo.size() ) );
    *aResponse.mutable_display_list() =
            StreamDisplayList( aRequestId, aDoc.id, *aDoc.gal, aDoc.items, false, aBulk );
    aResponse.set_ok( true );
}


void PCB_FACE::save( PCB_DOC& aDoc, const pb::Save& aReq, pb::Response& aResponse )
{
    wxString path = wxString::FromUTF8( aReq.path().empty() ? aDoc.path : aReq.path() );

    try
    {
        // Project settings stay as they are: only the board file is Triage's to write.
        if( !SaveBoard( path, aDoc.board.get(), true ) )
        {
            Fail( aResponse, "could not save " + path.ToStdString() );
            return;
        }
    }
    catch( const IO_ERROR& error )
    {
        Fail( aResponse, "could not save " + path.ToStdString() + ": " + error.What().ToStdString() );
        return;
    }

    if( aReq.path().empty() )
        aDoc.modified = false;

    aResponse.mutable_edit()->set_modified( aDoc.modified );
    aResponse.set_ok( true );
}

} // namespace TRIAGE
