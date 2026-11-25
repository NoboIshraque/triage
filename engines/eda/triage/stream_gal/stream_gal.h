/*
 * Triage: Stream GAL (ROADMAP P1-3, PLAN §4.3).
 * Licensed under GPL-3.0-or-later (docs/PLAN.md §5).
 *
 * A KIGFX::GAL backend that draws nothing. It records KiCad's draw calls, the
 * ones KiCad's painters make for every item on every layer, into display lists:
 * one per cached group, exactly the groups KiCad's VIEW creates for the OpenGL
 * GAL. Triage's schematic and board tabs draw those lists on the GPU
 * (app/src/vs/triage/browser/eda/), so the pictures come from KiCad's own
 * painters. The semantics of each call follow OPENGL_GAL (common/gal/opengl/).
 *
 * Primitives, all in world units (KiCad internal units) after the GAL's
 * transform stack has been applied:
 *   triangles  filled polygons, pies, glyph outlines (already triangulated)
 *   segments   capsules: two end points and a width (round ends)
 *   circles    discs (width 0) or rings (a stroke of that width on the radius)
 *   arcs       stroked arcs with round ends: centre, radius, start and end angle
 */

#pragma once

#include <gal/graphics_abstraction_layer.h>
#include <gal/gal_display_options.h>

#include <cstdint>
#include <map>
#include <set>
#include <string>
#include <vector>

class EDA_ITEM;

namespace TRIAGE
{

enum class PRIM : uint8_t
{
    TRIANGLES = 1,
    SEGMENTS = 2,
    CIRCLES = 3,
    ARCS = 4,
};

/// One run of primitives of the same kind and colour.
struct PRIM_RUN
{
    PRIM               kind;
    uint32_t           rgba;
    std::vector<float> data; // TRIANGLES: x,y per vertex; SEGMENTS: x1,y1,x2,y2,w;
                             // CIRCLES: cx,cy,r,w; ARCS: cx,cy,r,a0,a1,w
};

/// A cached group: what one item draws on one layer.
struct GROUP
{
    int                   id = -1;
    int                   layer = -1;      ///< VIEW layer the group was drawn for
    int                   order = 0;       ///< layer rendering order (depth) when drawn
    const EDA_ITEM*       item = nullptr;  ///< the item that drew it (null: a VIEW helper)
    std::string           uuid;            ///< the item's KIID, kept: the item may be gone
    double                lod = 0.0;       ///< visible while LOD < VIEW scale
    bool                  colorOverride = false;
    uint32_t              overrideRgba = 0;
    std::vector<PRIM_RUN> runs;

    size_t PrimitiveCount() const;
};


class STREAM_GAL : public KIGFX::GAL
{
public:
    explicit STREAM_GAL( KIGFX::GAL_DISPLAY_OPTIONS& aOptions );
    ~STREAM_GAL() override;

    // The painter wrapper tells the GAL which item it is drawing on which layer,
    // so the open group can be attributed (VIEW calls BeginGroup before Draw).
    void NoteItem( const EDA_ITEM* aItem, int aLayer, double aLod );

    // Group bookkeeping for the protocol.
    const std::map<int, GROUP>& Groups() const { return m_groups; }
    const GROUP* Group( int aId ) const;

    /// Groups created, changed or deleted since the last call; clears the lists.
    void TakeChanges( std::set<int>& aChanged, std::set<int>& aDeleted );

    /// Runs drawn outside any group (immediate mode); cleared by ClearImmediate().
    const std::vector<PRIM_RUN>& Immediate() const { return m_immediate; }
    void ClearImmediate() { m_immediate.clear(); }

    // ---- KIGFX::GAL ------------------------------------------------------
    bool IsInitialized() const override { return true; }
    bool IsVisible() const override { return true; }

    void DrawLine( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint ) override;
    void DrawSegment( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint,
                      double aWidth ) override;
    void DrawSegmentChain( const std::vector<VECTOR2D>& aPointList, double aWidth ) override;
    void DrawSegmentChain( const SHAPE_LINE_CHAIN& aLineChain, double aWidth ) override;
    void DrawPolyline( const std::deque<VECTOR2D>& aPointList ) override;
    void DrawPolyline( const std::vector<VECTOR2D>& aPointList ) override;
    void DrawPolyline( const VECTOR2D aPointList[], int aListSize ) override;
    void DrawPolyline( const SHAPE_LINE_CHAIN& aLineChain ) override;
    void DrawPolylines( const std::vector<std::vector<VECTOR2D>>& aPointLists ) override;
    void DrawCircle( const VECTOR2D& aCenterPoint, double aRadius ) override;
    void DrawHoleWall( const VECTOR2D& aCenterPoint, double aHoleRadius,
                       double aWallWidth ) override;
    void DrawArc( const VECTOR2D& aCenterPoint, double aRadius, const EDA_ANGLE& aStartAngle,
                  const EDA_ANGLE& aAngle ) override;
    void DrawArcSegment( const VECTOR2D& aCenterPoint, double aRadius,
                         const EDA_ANGLE& aStartAngle, const EDA_ANGLE& aAngle, double aWidth,
                         double aMaxError ) override;
    void DrawRectangle( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint ) override;
    void DrawGlyph( const KIFONT::GLYPH& aGlyph, int aNth, int aTotal ) override;
    void DrawGlyphs( const std::vector<std::unique_ptr<KIFONT::GLYPH>>& aGlyphs ) override;
    void DrawPolygon( const std::deque<VECTOR2D>& aPointList ) override;
    void DrawPolygon( const VECTOR2D aPointList[], int aListSize ) override;
    void DrawPolygon( const SHAPE_POLY_SET& aPolySet, bool aStrokeTriangulation = false ) override;
    void DrawPolygon( const SHAPE_LINE_CHAIN& aPolySet ) override;
    void DrawCurve( const VECTOR2D& startPoint, const VECTOR2D& controlPointA,
                    const VECTOR2D& controlPointB, const VECTOR2D& endPoint,
                    double aFilterValue = 0.0 ) override;
    void DrawBitmap( const BITMAP_BASE& aBitmap, double alphaBlend = 1.0 ) override;

    void Transform( const MATRIX3x3D& aTransformation ) override;
    void Rotate( double aAngle ) override;
    void Translate( const VECTOR2D& aTranslation ) override;
    void Scale( const VECTOR2D& aScale ) override;
    void Save() override;
    void Restore() override;

    int  BeginGroup() override;
    void EndGroup() override;
    void DrawGroup( int aGroupNumber ) override;
    void ChangeGroupColor( int aGroupNumber, const KIGFX::COLOR4D& aNewColor ) override;
    void ChangeGroupDepth( int aGroupNumber, int aDepth ) override;
    void DeleteGroup( int aGroupNumber ) override;
    void ClearCache() override;

    /// Bitmaps drawn so far (not streamed yet: P1-4 draws their outline).
    int BitmapCount() const { return m_bitmaps; }

private:
    struct AFFINE
    {
        // x' = a*x + c*y + e ; y' = b*x + d*y + f
        double a = 1, b = 0, c = 0, d = 1, e = 0, f = 0;

        VECTOR2D Apply( const VECTOR2D& p ) const { return { a * p.x + c * p.y + e, b * p.x + d * p.y + f }; }
        VECTOR2D ApplyVector( const VECTOR2D& p ) const { return { a * p.x + c * p.y, b * p.x + d * p.y }; }
        double   Det() const { return a * d - b * c; }
        double   ScaleFactor() const;
        AFFINE   operator*( const AFFINE& o ) const;
    };

    std::vector<PRIM_RUN>& target();
    PRIM_RUN&              run( PRIM aKind, const KIGFX::COLOR4D& aColor );

    void addSegment( const VECTOR2D& a, const VECTOR2D& b, double aWidth, const KIGFX::COLOR4D& c );
    void addCircle( const VECTOR2D& aCenter, double aRadius, double aWidth, const KIGFX::COLOR4D& c );
    void addArc( const VECTOR2D& aCenter, double aRadius, double aStart, double aEnd, double aWidth,
                 const KIGFX::COLOR4D& c );
    void addTriangle( const VECTOR2D& a, const VECTOR2D& b, const VECTOR2D& c,
                      const KIGFX::COLOR4D& aColor );

    void drawSegment( const VECTOR2D& aStart, const VECTOR2D& aEnd, double aWidth );
    void drawCircle( const VECTOR2D& aCenter, double aRadius );
    void drawStrokedSemiCircle( const VECTOR2D& aCenter, double aRadius, double aAngle );
    template <typename GET>
    void drawPolyline( GET aGet, int aCount );
    template <typename GET>
    void drawPolygon( GET aGet, int aCount );
    void fillPolySet( const SHAPE_POLY_SET& aPolySet );

    static uint32_t packColor( const KIGFX::COLOR4D& aColor );

    AFFINE                m_xform;
    std::vector<AFFINE>   m_xformStack;

    std::map<int, GROUP>  m_groups;
    int                   m_nextGroup = 1;
    int                   m_openGroup = -1;
    std::set<int>         m_changed;
    std::set<int>         m_deleted;
    std::vector<PRIM_RUN> m_immediate;
    int                   m_bitmaps = 0;
};

} // namespace TRIAGE
