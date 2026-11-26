/*
 * Triage: the board for the 3D view and the enclosure (ROADMAP P2-3 … P2-5).
 * GPL-3.0-or-later.
 *
 * GetBoard3D answers from the engine's live board, so edits that aren't saved
 * yet show in 3D too: the outline as KiCad builds it for its own 3D viewer and
 * STEP export (BOARD::GetBoardPolygonOutlines), the board's thickness, every
 * drilled pad hole, and each footprint's placement, courtyard, 3D model entries
 * and height. Lengths are in mm, in KiCad's board coordinates (Y down).
 *
 * A footprint's height comes from a "Height" field (for example "11 mm"); KiCad
 * itself only knows heights from 3D model files, which the engine doesn't load.
 */

#include "pcb_face.h"
#include "../common/face_util.h"

#include <board.h>
#include <board_design_settings.h>
#include <footprint.h>
#include <geometry/shape_line_chain.h>
#include <geometry/shape_poly_set.h>
#include <pad.h>
#include <pcb_field.h>

namespace TRIAGE
{

namespace
{

double mm( int aIU )
{
    return pcbIUScale.IUTomm( aIU );
}


void addPoint( google::protobuf::RepeatedPtrField<pb::Point2>* aOut, const VECTOR2I& aPoint )
{
    pb::Point2* p = aOut->Add();
    p->set_x( mm( aPoint.x ) );
    p->set_y( mm( aPoint.y ) );
}


/// A closed chain's points (arcs come approximated, as KiCad stores them).
void addChain( google::protobuf::RepeatedPtrField<pb::Point2>* aOut, const SHAPE_LINE_CHAIN& aChain )
{
    for( int i = 0; i < aChain.PointCount(); ++i )
        addPoint( aOut, aChain.CPoint( i ) );
}


/// The "Height" field in mm ("11", "11 mm", "11.5mm"); 0 when absent or unreadable.
double heightField( const FOOTPRINT& aFootprint )
{
    const PCB_FIELD* field = aFootprint.GetField( wxT( "Height" ) );

    if( !field )
        return 0.0;

    wxString text = field->GetText();
    text.Trim().Trim( false );
    text.Replace( wxT( "mm" ), wxEmptyString );
    text.Trim();
    double value = 0.0;
    if( text.IsEmpty() || !text.ToCDouble( &value ) || value < 0.0 )
        return 0.0;
    return value;
}

} // namespace


void PCB_FACE::board3D( PCB_DOC& aDoc, pb::Response& aResponse )
{
    BOARD&       board = *aDoc.board;
    pb::Board3D* out = aResponse.mutable_board_3d();
    out->set_thickness( mm( board.GetDesignSettings().GetBoardThickness() ) );

    SHAPE_POLY_SET outlines;
    out->set_outline_ok( board.GetBoardPolygonOutlines( outlines, true ) );

    for( int i = 0; i < outlines.OutlineCount(); ++i )
    {
        pb::Outline* outline = out->add_outlines();
        addChain( outline->mutable_points(), outlines.COutline( i ) );

        for( int h = 0; h < outlines.HoleCount( i ); ++h )
            addChain( outline->add_cutouts()->mutable_points(), outlines.CHole( i, h ) );
    }

    for( FOOTPRINT* fp : board.Footprints() )
    {
        fp->BuildCourtyardCaches();

        pb::Footprint3D* f = out->add_footprints();
        f->set_uuid( fp->m_Uuid.AsStdString() );
        f->set_reference( fp->GetReference().utf8_string() );
        f->set_value( fp->GetValue().utf8_string() );
        f->set_footprint( fp->GetFPIDAsString().utf8_string() );
        f->set_x( mm( fp->GetPosition().x ) );
        f->set_y( mm( fp->GetPosition().y ) );
        f->set_angle( fp->GetOrientation().AsDegrees() );
        f->set_back( fp->IsFlipped() );
        f->set_height( heightField( *fp ) );
        f->set_board_only( fp->IsBoardOnly() );

        const SHAPE_POLY_SET& courtyard = fp->GetCourtyard( fp->IsFlipped() ? B_CrtYd : F_CrtYd );

        if( courtyard.OutlineCount() > 0 )
        {
            addChain( f->mutable_courtyard(), courtyard.COutline( 0 ) );
        }
        else
        {
            const BOX2I box = fp->GetBoundingBox( false );
            addPoint( f->mutable_courtyard(), box.GetOrigin() );
            addPoint( f->mutable_courtyard(), VECTOR2I( box.GetRight(), box.GetTop() ) );
            addPoint( f->mutable_courtyard(), box.GetEnd() );
            addPoint( f->mutable_courtyard(), VECTOR2I( box.GetLeft(), box.GetBottom() ) );
        }

        for( const FP_3DMODEL& model : fp->Models() )
        {
            pb::Model3D* m = f->add_models();
            m->set_path( model.m_Filename.utf8_string() );
            m->set_show( model.m_Show );

            for( double v : { model.m_Offset.x, model.m_Offset.y, model.m_Offset.z } )
                m->add_offset( v );

            for( double v : { model.m_Rotation.x, model.m_Rotation.y, model.m_Rotation.z } )
                m->add_rotation( v );

            for( double v : { model.m_Scale.x, model.m_Scale.y, model.m_Scale.z } )
                m->add_scale( v );
        }

        for( const PAD* pad : fp->Pads() )
        {
            if( !pad->HasHole() )
                continue;

            pb::Hole* hole = out->add_holes();
            hole->set_x( mm( pad->GetPosition().x ) );
            hole->set_y( mm( pad->GetPosition().y ) );
            hole->set_width( mm( pad->GetDrillSizeX() ) );
            hole->set_height( mm( pad->GetDrillSizeY() ) );
            hole->set_angle( pad->GetOrientation().AsDegrees() );
            hole->set_plated( pad->GetAttribute() != PAD_ATTRIB::NPTH );
            hole->set_footprint( fp->GetReference().utf8_string() );
            hole->set_pad( pad->GetNumber().utf8_string() );
        }
    }

    aResponse.set_ok( true );
}

} // namespace TRIAGE
