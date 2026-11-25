/*
 * Triage: Stream GAL (ROADMAP P1-3). Licensed under GPL-3.0-or-later.
 * See stream_gal.h. Each Draw* method follows the same-named method of
 * OPENGL_GAL (common/gal/opengl/opengl_gal.cpp in KiCad 10.0.8): the same
 * fill and stroke flags, colours and widths decide what is drawn.
 */

#include "stream_gal.h"

#include <bezier_curves.h>
#include <eda_item.h>
#include <font/glyph.h>
#include <geometry/shape_line_chain.h>
#include <geometry/shape_poly_set.h>
#include <math/matrix3x3.h>
#include <math/util.h>

#include <algorithm>
#include <cmath>

using KIGFX::COLOR4D;

namespace TRIAGE
{

size_t GROUP::PrimitiveCount() const
{
    size_t n = 0;

    for( const PRIM_RUN& run : runs )
    {
        switch( run.kind )
        {
        case PRIM::TRIANGLES: n += run.data.size() / 6; break;
        case PRIM::SEGMENTS: n += run.data.size() / 5; break;
        case PRIM::CIRCLES: n += run.data.size() / 4; break;
        case PRIM::ARCS: n += run.data.size() / 6; break;
        }
    }

    return n;
}


double STREAM_GAL::AFFINE::ScaleFactor() const
{
    return std::sqrt( std::fabs( Det() ) );
}


STREAM_GAL::AFFINE STREAM_GAL::AFFINE::operator*( const AFFINE& o ) const
{
    AFFINE r;
    r.a = a * o.a + c * o.b;
    r.b = b * o.a + d * o.b;
    r.c = a * o.c + c * o.d;
    r.d = b * o.c + d * o.d;
    r.e = a * o.e + c * o.f + e;
    r.f = b * o.e + d * o.f + f;
    return r;
}


STREAM_GAL::STREAM_GAL( KIGFX::GAL_DISPLAY_OPTIONS& aOptions ) :
        GAL( aOptions )
{
    // A virtual screen large enough that VIEW never clips: the client owns the camera.
    ResizeScreen( 4096, 4096 );
}


STREAM_GAL::~STREAM_GAL() = default;


uint32_t STREAM_GAL::packColor( const COLOR4D& aColor )
{
    auto channel = []( double v ) -> uint32_t
    {
        return static_cast<uint32_t>( std::clamp( std::lround( v * 255.0 ), 0L, 255L ) );
    };

    return ( channel( aColor.r ) << 24 ) | ( channel( aColor.g ) << 16 )
           | ( channel( aColor.b ) << 8 ) | channel( aColor.a );
}


void STREAM_GAL::NoteItem( const EDA_ITEM* aItem, int aLayer, double aLod )
{
    if( m_openGroup < 0 )
        return;

    GROUP& group = m_groups[m_openGroup];

    if( group.item == nullptr && aItem )
    {
        group.item = aItem;
        group.uuid = aItem->m_Uuid.AsStdString();
    }

    if( group.layer < 0 )
        group.layer = aLayer;

    group.lod = aLod;
}


const GROUP* STREAM_GAL::Group( int aId ) const
{
    auto it = m_groups.find( aId );
    return it == m_groups.end() ? nullptr : &it->second;
}


void STREAM_GAL::TakeChanges( std::set<int>& aChanged, std::set<int>& aDeleted )
{
    aChanged.swap( m_changed );
    aDeleted.swap( m_deleted );
    m_changed.clear();
    m_deleted.clear();
}


std::vector<PRIM_RUN>& STREAM_GAL::target()
{
    if( m_openGroup >= 0 )
        return m_groups[m_openGroup].runs;

    return m_immediate;
}


PRIM_RUN& STREAM_GAL::run( PRIM aKind, const COLOR4D& aColor )
{
    std::vector<PRIM_RUN>& runs = target();
    const uint32_t         rgba = packColor( aColor );

    if( runs.empty() || runs.back().kind != aKind || runs.back().rgba != rgba )
        runs.push_back( PRIM_RUN{ aKind, rgba, {} } );

    return runs.back();
}


void STREAM_GAL::addSegment( const VECTOR2D& a, const VECTOR2D& b, double aWidth,
                             const COLOR4D& c )
{
    const VECTOR2D pa = m_xform.Apply( a );
    const VECTOR2D pb = m_xform.Apply( b );
    const double   w = aWidth * m_xform.ScaleFactor();
    PRIM_RUN&      r = run( PRIM::SEGMENTS, c );

    r.data.insert( r.data.end(), { float( pa.x ), float( pa.y ), float( pb.x ), float( pb.y ),
                                   float( w ) } );
}


void STREAM_GAL::addCircle( const VECTOR2D& aCenter, double aRadius, double aWidth,
                            const COLOR4D& c )
{
    const VECTOR2D p = m_xform.Apply( aCenter );
    const double   s = m_xform.ScaleFactor();
    PRIM_RUN&      r = run( PRIM::CIRCLES, c );

    r.data.insert( r.data.end(),
                   { float( p.x ), float( p.y ), float( aRadius * s ), float( aWidth * s ) } );
}


void STREAM_GAL::addArc( const VECTOR2D& aCenter, double aRadius, double aStart, double aEnd,
                         double aWidth, const COLOR4D& c )
{
    // Transform the arc's end directions; a mirroring transform reverses the sweep.
    const VECTOR2D p = m_xform.Apply( aCenter );
    const double   s = m_xform.ScaleFactor();
    const VECTOR2D d0 = m_xform.ApplyVector( { std::cos( aStart ), std::sin( aStart ) } );
    double         a0 = std::atan2( d0.y, d0.x );
    double         sweep = aEnd - aStart;

    if( m_xform.Det() < 0 )
        sweep = -sweep;

    double a1 = a0 + sweep;

    if( a1 < a0 )
        std::swap( a0, a1 );

    PRIM_RUN& r = run( PRIM::ARCS, c );
    r.data.insert( r.data.end(), { float( p.x ), float( p.y ), float( aRadius * s ), float( a0 ),
                                   float( a1 ), float( aWidth * s ) } );
}


void STREAM_GAL::addTriangle( const VECTOR2D& a, const VECTOR2D& b, const VECTOR2D& c,
                              const COLOR4D& aColor )
{
    const VECTOR2D pa = m_xform.Apply( a );
    const VECTOR2D pb = m_xform.Apply( b );
    const VECTOR2D pc = m_xform.Apply( c );
    PRIM_RUN&      r = run( PRIM::TRIANGLES, aColor );

    r.data.insert( r.data.end(), { float( pa.x ), float( pa.y ), float( pb.x ), float( pb.y ),
                                   float( pc.x ), float( pc.y ) } );
}


// ---- Primitives (OPENGL_GAL semantics) ------------------------------------------------------

void STREAM_GAL::DrawLine( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint )
{
    addSegment( aStartPoint, aEndPoint, m_lineWidth, m_strokeColor );
}


void STREAM_GAL::drawSegment( const VECTOR2D& aStart, const VECTOR2D& aEnd, double aWidth )
{
    if( float( aStart.x ) == float( aEnd.x ) && float( aStart.y ) == float( aEnd.y ) )
    {
        drawCircle( aStart, aWidth / 2 );
        return;
    }

    if( m_isFillEnabled || aWidth == 1.0 )
    {
        addSegment( aStart, aEnd, aWidth, m_fillColor );
        return;
    }

    // Outlined segment: two sides and two semicircle caps, 1 unit wide (OPENGL_GAL
    // relies on its shader's minimum of one pixel; so does Triage's renderer).
    const VECTOR2D dir = aEnd - aStart;
    const double   length = dir.EuclideanNorm();
    const double   angle = std::atan2( dir.y, dir.x );
    const double   saved = m_lineWidth;

    Save();
    Translate( aStart );
    Rotate( angle );
    m_lineWidth = 1.0;
    addSegment( { 0.0, aWidth / 2.0 }, { length, aWidth / 2.0 }, 1.0, m_strokeColor );
    addSegment( { 0.0, -aWidth / 2.0 }, { length, -aWidth / 2.0 }, 1.0, m_strokeColor );
    drawStrokedSemiCircle( { 0.0, 0.0 }, aWidth / 2, M_PI / 2 );
    drawStrokedSemiCircle( { length, 0.0 }, aWidth / 2, -M_PI / 2 );
    m_lineWidth = saved;
    Restore();
}


void STREAM_GAL::drawStrokedSemiCircle( const VECTOR2D& aCenter, double aRadius, double aAngle )
{
    // OPENGL_GAL's semicircle at aAngle covers the half-plane on the +y side of the
    // rotated frame: angles aAngle .. aAngle + pi.
    addArc( aCenter, aRadius, aAngle, aAngle + M_PI, m_lineWidth, m_strokeColor );
}


void STREAM_GAL::DrawSegment( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint,
                              double aWidth )
{
    drawSegment( aStartPoint, aEndPoint, aWidth );
}


void STREAM_GAL::DrawSegmentChain( const std::vector<VECTOR2D>& aPointList, double aWidth )
{
    for( size_t i = 1; i < aPointList.size(); ++i )
        drawSegment( aPointList[i - 1], aPointList[i], aWidth );
}


void STREAM_GAL::DrawSegmentChain( const SHAPE_LINE_CHAIN& aLineChain, double aWidth )
{
    int count = aLineChain.PointCount();

    if( aLineChain.IsClosed() )
        count += 1;

    for( int i = 1; i < count; ++i )
        drawSegment( aLineChain.CPoint( i - 1 ), aLineChain.CPoint( i ), aWidth );
}


template <typename GET>
void STREAM_GAL::drawPolyline( GET aGet, int aCount )
{
    if( aCount <= 0 )
        return;

    if( aCount == 1 )
    {
        addSegment( aGet( 0 ), aGet( 0 ), m_lineWidth, m_strokeColor );
        return;
    }

    for( int i = 1; i < aCount; ++i )
        addSegment( aGet( i - 1 ), aGet( i ), m_lineWidth, m_strokeColor );
}


void STREAM_GAL::DrawPolyline( const std::deque<VECTOR2D>& aPointList )
{
    drawPolyline( [&]( int i ) { return aPointList[i]; }, (int) aPointList.size() );
}


void STREAM_GAL::DrawPolyline( const std::vector<VECTOR2D>& aPointList )
{
    drawPolyline( [&]( int i ) { return aPointList[i]; }, (int) aPointList.size() );
}


void STREAM_GAL::DrawPolyline( const VECTOR2D aPointList[], int aListSize )
{
    drawPolyline( [&]( int i ) { return aPointList[i]; }, aListSize );
}


void STREAM_GAL::DrawPolyline( const SHAPE_LINE_CHAIN& aLineChain )
{
    int count = aLineChain.PointCount();

    if( aLineChain.IsClosed() )
        count += 1;

    drawPolyline( [&]( int i ) { return VECTOR2D( aLineChain.CPoint( i ) ); }, count );
}


void STREAM_GAL::DrawPolylines( const std::vector<std::vector<VECTOR2D>>& aPointLists )
{
    for( const std::vector<VECTOR2D>& points : aPointLists )
        DrawPolyline( points );
}


void STREAM_GAL::drawCircle( const VECTOR2D& aCenter, double aRadius )
{
    if( m_isFillEnabled )
        addCircle( aCenter, aRadius, 0.0, m_fillColor );

    if( m_isStrokeEnabled )
        addCircle( aCenter, aRadius, m_lineWidth, m_strokeColor );
}


void STREAM_GAL::DrawCircle( const VECTOR2D& aCenterPoint, double aRadius )
{
    drawCircle( aCenterPoint, aRadius );
}


void STREAM_GAL::DrawHoleWall( const VECTOR2D& aCenterPoint, double aHoleRadius,
                               double aWallWidth )
{
    // A ring from the hole's edge outwards, aWallWidth wide.
    if( m_isFillEnabled )
        addCircle( aCenterPoint, aHoleRadius + aWallWidth / 2.0, aWallWidth, m_fillColor );
}


static void normalizeAngles( double& aStart, double& aEnd )
{
    // As OPENGL_GAL::normalize: start before end, start in [0, 2pi).
    if( aStart > aEnd )
        std::swap( aStart, aEnd );

    while( aStart < 0 )
    {
        aStart += 2 * M_PI;
        aEnd += 2 * M_PI;
    }

    while( aStart >= 2 * M_PI )
    {
        aStart -= 2 * M_PI;
        aEnd -= 2 * M_PI;
    }
}


void STREAM_GAL::DrawArc( const VECTOR2D& aCenterPoint, double aRadius,
                          const EDA_ANGLE& aStartAngle, const EDA_ANGLE& aAngle )
{
    if( aRadius <= 0 )
        return;

    double start = aStartAngle.AsRadians();
    double end = start + aAngle.AsRadians();
    normalizeAngles( start, end );

    if( m_isFillEnabled )
    {
        // Pie: a triangle fan, 64 steps per full turn at most.
        const int    steps = std::max( 1, int( std::ceil( ( end - start ) / ( 2 * M_PI ) * 64 ) ) );
        const double step = ( end - start ) / steps;

        for( int i = 0; i < steps; ++i )
        {
            const double a = start + i * step;
            const double b = a + step;
            addTriangle( aCenterPoint,
                         aCenterPoint + VECTOR2D( std::cos( a ), std::sin( a ) ) * aRadius,
                         aCenterPoint + VECTOR2D( std::cos( b ), std::sin( b ) ) * aRadius,
                         m_fillColor );
        }
    }

    if( m_isStrokeEnabled )
        addArc( aCenterPoint, aRadius, start, end, m_lineWidth, m_strokeColor );
}


void STREAM_GAL::DrawArcSegment( const VECTOR2D& aCenterPoint, double aRadius,
                                 const EDA_ANGLE& aStartAngle, const EDA_ANGLE& aAngle,
                                 double aWidth, double aMaxError )
{
    (void) aMaxError; // the GPU draws exact arcs

    if( aRadius <= 0 )
    {
        if( aWidth > 0 )
            DrawCircle( aCenterPoint, aWidth / 2.0 );

        return;
    }

    double start = aStartAngle.AsRadians();
    double end = start + aAngle.AsRadians();
    normalizeAngles( start, end );

    if( m_isStrokeEnabled )
    {
        // Outline: inner and outer edges plus semicircle caps, at the stroke width.
        const double   half = aWidth / 2.0;
        const VECTOR2D s( std::cos( start ) * aRadius, std::sin( start ) * aRadius );
        const VECTOR2D e( std::cos( end ) * aRadius, std::sin( end ) * aRadius );

        addArc( aCenterPoint, aRadius + half, start, end, m_lineWidth, m_strokeColor );

        if( aRadius - half > 0 )
            addArc( aCenterPoint, aRadius - half, start, end, m_lineWidth, m_strokeColor );

        drawStrokedSemiCircle( aCenterPoint + s, half, start + M_PI );
        drawStrokedSemiCircle( aCenterPoint + e, half, end );
    }

    if( m_isFillEnabled )
        addArc( aCenterPoint, aRadius, start, end, aWidth, m_fillColor );
}


void STREAM_GAL::DrawRectangle( const VECTOR2D& aStartPoint, const VECTOR2D& aEndPoint )
{
    const VECTOR2D a( aEndPoint.x, aStartPoint.y );
    const VECTOR2D b( aStartPoint.x, aEndPoint.y );

    if( m_isFillEnabled )
    {
        addTriangle( aStartPoint, a, aEndPoint, m_fillColor );
        addTriangle( aStartPoint, aEndPoint, b, m_fillColor );
    }

    if( m_isStrokeEnabled )
    {
        if( aStartPoint == aEndPoint )
        {
            DrawLine( aStartPoint + VECTOR2D( 1.0, 0.0 ), aEndPoint );
        }
        else
        {
            const VECTOR2D points[] = { aStartPoint, a, aEndPoint, b, aStartPoint };
            DrawPolyline( points, 5 );
        }
    }
}


void STREAM_GAL::DrawGlyph( const KIFONT::GLYPH& aGlyph, int aNth, int aTotal )
{
    (void) aNth;
    (void) aTotal;

    if( aGlyph.IsStroke() )
    {
        const auto& glyph = static_cast<const KIFONT::STROKE_GLYPH&>( aGlyph );
        DrawPolylines( glyph );
    }
    else if( aGlyph.IsOutline() )
    {
        const auto& glyph = static_cast<const KIFONT::OUTLINE_GLYPH&>( aGlyph );

        glyph.Triangulate(
                [&]( const VECTOR2I& a, const VECTOR2I& b, const VECTOR2I& c )
                {
                    addTriangle( a, b, c, m_fillColor );
                } );
    }
}


void STREAM_GAL::DrawGlyphs( const std::vector<std::unique_ptr<KIFONT::GLYPH>>& aGlyphs )
{
    for( size_t i = 0; i < aGlyphs.size(); ++i )
        DrawGlyph( *aGlyphs[i], int( i ), int( aGlyphs.size() ) );
}


void STREAM_GAL::fillPolySet( const SHAPE_POLY_SET& aPolySet )
{
    for( unsigned int j = 0; j < aPolySet.TriangulatedPolyCount(); ++j )
    {
        const auto* triPoly = aPolySet.TriangulatedPolygon( j );

        for( size_t i = 0; i < triPoly->GetTriangleCount(); ++i )
        {
            VECTOR2I a, b, c;
            triPoly->GetTriangle( int( i ), a, b, c );
            addTriangle( a, b, c, m_fillColor );
        }
    }
}


template <typename GET>
void STREAM_GAL::drawPolygon( GET aGet, int aCount )
{
    if( aCount < 2 )
        return;

    if( m_isFillEnabled && aCount >= 3 )
    {
        // OPENGL_GAL tessellates with GLU (odd winding). KiCad's own triangulation
        // covers the simple polygons painters draw; a polygon it can't triangulate
        // (self-intersecting) falls back to a fan.
        SHAPE_POLY_SET   poly;
        SHAPE_LINE_CHAIN chain;

        for( int i = 0; i < aCount; ++i )
        {
            const VECTOR2D p = aGet( i );
            chain.Append( KiROUND( p.x ), KiROUND( p.y ), true );
        }

        chain.SetClosed( true );
        poly.AddOutline( chain );
        poly.CacheTriangulation( false );

        if( poly.IsTriangulationUpToDate() && poly.TriangulatedPolyCount() > 0 )
        {
            fillPolySet( poly );
        }
        else
        {
            for( int i = 2; i < aCount; ++i )
                addTriangle( aGet( 0 ), aGet( i - 1 ), aGet( i ), m_fillColor );
        }
    }

    if( m_isStrokeEnabled )
        drawPolyline( aGet, aCount );
}


void STREAM_GAL::DrawPolygon( const std::deque<VECTOR2D>& aPointList )
{
    drawPolygon( [&]( int i ) { return aPointList[i]; }, (int) aPointList.size() );
}


void STREAM_GAL::DrawPolygon( const VECTOR2D aPointList[], int aListSize )
{
    drawPolygon( [&]( int i ) { return aPointList[i]; }, aListSize );
}


void STREAM_GAL::DrawPolygon( const SHAPE_POLY_SET& aPolySet, bool aStrokeTriangulation )
{
    (void) aStrokeTriangulation; // a debugging aid in OPENGL_GAL

    const SHAPE_POLY_SET* polys = &aPolySet;
    SHAPE_POLY_SET        triangulated;

    if( !aPolySet.IsTriangulationUpToDate() )
    {
        triangulated = aPolySet;
        triangulated.CacheTriangulation( false );
        polys = &triangulated;
    }

    if( m_isFillEnabled )
        fillPolySet( *polys );

    if( m_isStrokeEnabled )
    {
        for( int j = 0; j < aPolySet.OutlineCount(); ++j )
        {
            for( const SHAPE_LINE_CHAIN& chain : aPolySet.Polygon( j ) )
                DrawPolyline( chain );
        }
    }
}


void STREAM_GAL::DrawPolygon( const SHAPE_LINE_CHAIN& aPolygon )
{
    if( aPolygon.PointCount() < 2 )
        return;

    const int count = aPolygon.SegmentCount() + 1;
    drawPolygon( [&]( int i ) { return VECTOR2D( aPolygon.CPoint( i ) ); }, count );
}


void STREAM_GAL::DrawCurve( const VECTOR2D& aStartPoint, const VECTOR2D& aControlPointA,
                            const VECTOR2D& aControlPointB, const VECTOR2D& aEndPoint,
                            double aFilterValue )
{
    std::vector<VECTOR2D> output;
    std::vector<VECTOR2D> control{ aStartPoint, aControlPointA, aControlPointB, aEndPoint };

    BEZIER_POLY converter( control );
    converter.GetPoly( output, aFilterValue );

    if( output.size() == 1 )
        output.push_back( output.front() );

    DrawPolygon( output.data(), int( output.size() ) );
}


void STREAM_GAL::DrawBitmap( const BITMAP_BASE& aBitmap, double alphaBlend )
{
    (void) aBitmap;
    (void) alphaBlend;
    m_bitmaps++;
}


// ---- Transforms ---------------------------------------------------------------------------

void STREAM_GAL::Transform( const MATRIX3x3D& aTransformation )
{
    AFFINE t;
    t.a = aTransformation.m_data[0][0];
    t.c = aTransformation.m_data[0][1];
    t.e = aTransformation.m_data[0][2];
    t.b = aTransformation.m_data[1][0];
    t.d = aTransformation.m_data[1][1];
    t.f = aTransformation.m_data[1][2];
    m_xform = m_xform * t;
}


void STREAM_GAL::Rotate( double aAngle )
{
    AFFINE t;
    t.a = std::cos( aAngle );
    t.b = std::sin( aAngle );
    t.c = -t.b;
    t.d = t.a;
    m_xform = m_xform * t;
}


void STREAM_GAL::Translate( const VECTOR2D& aTranslation )
{
    AFFINE t;
    t.e = aTranslation.x;
    t.f = aTranslation.y;
    m_xform = m_xform * t;
}


void STREAM_GAL::Scale( const VECTOR2D& aScale )
{
    AFFINE t;
    t.a = aScale.x;
    t.d = aScale.y;
    m_xform = m_xform * t;
}


void STREAM_GAL::Save()
{
    m_xformStack.push_back( m_xform );
}


void STREAM_GAL::Restore()
{
    if( !m_xformStack.empty() )
    {
        m_xform = m_xformStack.back();
        m_xformStack.pop_back();
    }
}


// ---- Groups -------------------------------------------------------------------------------

int STREAM_GAL::BeginGroup()
{
    const int id = m_nextGroup++;
    GROUP&    group = m_groups[id];
    group.id = id;
    group.order = int( m_layerDepth );
    m_openGroup = id;
    m_changed.insert( id );
    m_deleted.erase( id );
    return id;
}


void STREAM_GAL::EndGroup()
{
    m_openGroup = -1;
}


void STREAM_GAL::DrawGroup( int aGroupNumber )
{
    (void) aGroupNumber; // the client draws every group, layer by layer
}


void STREAM_GAL::ChangeGroupColor( int aGroupNumber, const COLOR4D& aNewColor )
{
    auto it = m_groups.find( aGroupNumber );

    if( it == m_groups.end() )
        return;

    it->second.colorOverride = true;
    it->second.overrideRgba = packColor( aNewColor );
    m_changed.insert( aGroupNumber );
}


void STREAM_GAL::ChangeGroupDepth( int aGroupNumber, int aDepth )
{
    auto it = m_groups.find( aGroupNumber );

    if( it == m_groups.end() )
        return;

    it->second.order = aDepth;
    m_changed.insert( aGroupNumber );
}


void STREAM_GAL::DeleteGroup( int aGroupNumber )
{
    if( m_groups.erase( aGroupNumber ) )
    {
        m_changed.erase( aGroupNumber );
        m_deleted.insert( aGroupNumber );
    }
}


void STREAM_GAL::ClearCache()
{
    for( const auto& [id, group] : m_groups )
        m_deleted.insert( id );

    m_groups.clear();
    m_changed.clear();
}

} // namespace TRIAGE
