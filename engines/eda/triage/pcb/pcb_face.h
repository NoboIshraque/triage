/*
 * Triage: the board engine face (ROADMAP P1-2). GPL-3.0-or-later.
 */

#pragma once

#include "../common/engine_face.h"
#include "../stream_gal/display_list.h"
#include "../stream_gal/stream_gal.h"

#include <gal/gal_display_options.h>
#include <kiid.h>
#include <units_provider.h>

#include <triage/eda/v1/engine.pb.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

class BOARD;
class BOARD_ITEM;
class DS_PROXY_VIEW_ITEM;
class RATSNEST_VIEW_ITEM;

namespace KIGFX
{
class PCB_PAINTER;
class PCB_VIEW;
} // namespace KIGFX

namespace TRIAGE
{

namespace pb = triage::eda::v1;

template <typename PAINTER_T>
class NOTING_PAINTER;

/// One undoable change to one board item (pcb_edit.cpp).
struct PCB_CHANGE
{
    enum class KIND
    {
        ADDED,   ///< `item` was added; undo removes it
        REMOVED, ///< `owned` was removed; undo puts it back
        CHANGED, ///< `owned` holds the other state; undo swaps it in
    };

    KIND                        kind;
    BOARD_ITEM*                 item = nullptr;
    std::unique_ptr<BOARD_ITEM> owned;
};

using PCB_CHANGE_SET = std::vector<PCB_CHANGE>;

struct PCB_DOC
{
    ~PCB_DOC();

    uint32_t                    id = 0;
    std::string                 path;
    bool                        modified = false;
    std::unique_ptr<BOARD>      board;
    KIGFX::GAL_DISPLAY_OPTIONS  galOptions;
    std::unique_ptr<STREAM_GAL> gal;
    std::unique_ptr<NOTING_PAINTER<KIGFX::PCB_PAINTER>> painter;
    std::unique_ptr<KIGFX::PCB_VIEW>     view;
    std::unique_ptr<RATSNEST_VIEW_ITEM>  ratsnest;
    std::unique_ptr<DS_PROXY_VIEW_ITEM>  drawingSheet;
    std::unique_ptr<UNITS_PROVIDER>      unitsProvider =
            std::make_unique<UNITS_PROVIDER>( pcbIUScale, EDA_UNITS::MM );
    ITEM_INDEX                  items;
    std::vector<KIID>           selection;
    std::vector<PCB_CHANGE_SET> undo;
    std::vector<PCB_CHANGE_SET> redo;
};


class PCB_FACE : public ENGINE_FACE
{
public:
    const char* Name() const override { return "pcb"; }
    bool        Accepts( const std::string& aPath ) const override;
    void        Open( uint32_t aDocument, const std::string& aPath,
                      pb::Response& aResponse ) override;
    void        Handle( const pb::Request& aRequest, pb::Response& aResponse,
                        const BULK_SINK& aBulk ) override;

private:
    PCB_DOC*    doc( uint32_t aId, pb::Response& aResponse );
    void        setupView( PCB_DOC& aDoc );
    void        fillInfo( PCB_DOC& aDoc, pb::DocumentInfo* aInfo );
    void        fillItem( PCB_DOC& aDoc, const BOARD_ITEM* aItem, pb::Item* aOut );
    BOARD_ITEM* findItem( PCB_DOC& aDoc, const std::string& aUuid );

    void hitTest( PCB_DOC& aDoc, const pb::HitTest& aReq, pb::Response& aResponse );
    void setSelection( PCB_DOC& aDoc, const pb::SetSelection& aReq, pb::Response& aResponse,
                       uint64_t aRequestId, const BULK_SINK& aBulk );
    void highlight( PCB_DOC& aDoc, const pb::Highlight& aReq, pb::Response& aResponse,
                    uint64_t aRequestId, const BULK_SINK& aBulk );
    void netlist( PCB_DOC& aDoc, pb::Response& aResponse );
    void getItems( PCB_DOC& aDoc, const pb::GetItems& aReq, pb::Response& aResponse );

    // pcb_edit.cpp
    void edit( PCB_DOC& aDoc, const pb::Edit& aReq, pb::Response& aResponse, uint64_t aRequestId,
               const BULK_SINK& aBulk );
    void undoRedo( PCB_DOC& aDoc, bool aUndo, pb::Response& aResponse, uint64_t aRequestId,
                   const BULK_SINK& aBulk );
    void save( PCB_DOC& aDoc, const pb::Save& aReq, pb::Response& aResponse );
    void refreshConnectivity( PCB_DOC& aDoc );
    void commit( PCB_DOC& aDoc, PCB_CHANGE_SET&& aChanges, pb::Response& aResponse,
                 uint64_t aRequestId, const BULK_SINK& aBulk );

    std::map<uint32_t, std::unique_ptr<PCB_DOC>> m_docs;
};

} // namespace TRIAGE
