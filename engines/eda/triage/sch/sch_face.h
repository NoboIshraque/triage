/*
 * Triage: the schematic engine face (ROADMAP P1-2). GPL-3.0-or-later.
 */

#pragma once

#include "../common/engine_face.h"
#include "../stream_gal/display_list.h"
#include "../stream_gal/stream_gal.h"

#include <gal/gal_display_options.h>
#include <kiid.h>
#include <sch_sheet_path.h>
#include <units_provider.h>

#include <triage/eda/v1/engine.pb.h>

#include <map>
#include <memory>
#include <string>
#include <vector>

class SCHEMATIC;
class SCH_ITEM;
class SCH_SCREEN;

namespace KIGFX
{
class SCH_PAINTER;
class SCH_VIEW;
} // namespace KIGFX

namespace TRIAGE
{

namespace pb = triage::eda::v1;

template <typename PAINTER_T>
class NOTING_PAINTER;

/// One undoable change to one schematic item (sch_edit.cpp).
struct SCH_CHANGE
{
    enum class KIND
    {
        ADDED,
        REMOVED,
        CHANGED,
    };

    KIND                      kind;
    SCH_SCREEN*               screen = nullptr;
    SCH_ITEM*                 item = nullptr;
    std::unique_ptr<SCH_ITEM> owned;
};

using SCH_CHANGE_SET = std::vector<SCH_CHANGE>;

struct SCH_DOC
{
    ~SCH_DOC();

    uint32_t                    id = 0;
    std::string                 path;
    bool                        modified = false;
    std::unique_ptr<SCHEMATIC>  schematic;
    SCH_SHEET_PATH              sheet;  ///< the sheet the view shows
    KIGFX::GAL_DISPLAY_OPTIONS  galOptions;
    std::unique_ptr<STREAM_GAL> gal;
    std::unique_ptr<NOTING_PAINTER<KIGFX::SCH_PAINTER>> painter;
    std::unique_ptr<KIGFX::SCH_VIEW>     view;
    std::unique_ptr<UNITS_PROVIDER>      unitsProvider =
            std::make_unique<UNITS_PROVIDER>( schIUScale, EDA_UNITS::MM );
    ITEM_INDEX                  items;
    std::vector<KIID>           selection;
    std::vector<SCH_CHANGE_SET> undo;
    std::vector<SCH_CHANGE_SET> redo;
};


class SCH_FACE : public ENGINE_FACE
{
public:
    const char* Name() const override { return "sch"; }
    bool        Accepts( const std::string& aPath ) const override;
    void        Open( uint32_t aDocument, const std::string& aPath,
                      pb::Response& aResponse ) override;
    void        Handle( const pb::Request& aRequest, pb::Response& aResponse,
                        const BULK_SINK& aBulk ) override;

private:
    SCH_DOC*  doc( uint32_t aId, pb::Response& aResponse );
    void      setupView( SCH_DOC& aDoc );
    bool      showSheet( SCH_DOC& aDoc, const std::string& aSheetPath );
    void      fillInfo( SCH_DOC& aDoc, pb::DocumentInfo* aInfo );
    void      fillItem( SCH_DOC& aDoc, const SCH_ITEM* aItem, pb::Item* aOut );
    SCH_ITEM* findItem( SCH_DOC& aDoc, const std::string& aUuid, SCH_SCREEN** aScreen = nullptr );

    void hitTest( SCH_DOC& aDoc, const pb::HitTest& aReq, pb::Response& aResponse );
    void setSelection( SCH_DOC& aDoc, const pb::SetSelection& aReq, pb::Response& aResponse,
                       uint64_t aRequestId, const BULK_SINK& aBulk );
    void highlight( SCH_DOC& aDoc, const pb::Highlight& aReq, pb::Response& aResponse,
                    uint64_t aRequestId, const BULK_SINK& aBulk );
    void netlist( SCH_DOC& aDoc, pb::Response& aResponse );
    void getItems( SCH_DOC& aDoc, const pb::GetItems& aReq, pb::Response& aResponse );

    // sch_edit.cpp
    void edit( SCH_DOC& aDoc, const pb::Edit& aReq, pb::Response& aResponse, uint64_t aRequestId,
               const BULK_SINK& aBulk );
    void undoRedo( SCH_DOC& aDoc, bool aUndo, pb::Response& aResponse, uint64_t aRequestId,
                   const BULK_SINK& aBulk );
    void save( SCH_DOC& aDoc, const pb::Save& aReq, pb::Response& aResponse );
    void commit( SCH_DOC& aDoc, SCH_CHANGE_SET&& aChanges, pb::Response& aResponse,
                 uint64_t aRequestId, const BULK_SINK& aBulk );
    void refreshConnectivity( SCH_DOC& aDoc );

    std::map<uint32_t, std::unique_ptr<SCH_DOC>> m_docs;
};

} // namespace TRIAGE
