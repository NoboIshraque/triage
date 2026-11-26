/*
 * triage-eda-engine: request routing (ROADMAP P1-2). GPL-3.0-or-later.
 *
 * Frames are the P0-4 engine connection's (engines/hello: u32 length of type +
 * payload, u8 type, payload). Types used here:
 *   0x01 Hello        engine -> broker  "triage-eda-engine <version> <pid>"
 *   0x02/0x03         Ping / Pong
 *   0x20 Request      broker -> engine  triage.eda.v1.Request
 *   0x21 Response     engine -> broker  triage.eda.v1.Response (same id)
 *   0x22 DisplayList  engine -> broker  one display-list chunk (stream_gal/display_list.h),
 *                                       sent before the Response of the request
 *   0x7f Error        engine -> broker  text
 */

#include "host.h"

#include "../common/engine_face.h"

#include <triage/hello/protocol.hpp>
#include <triage/hello/transport.hpp>
#include <triage/eda/v1/engine.pb.h>

#include <build_version.h>
#include <ki_exception.h>
#include <kiface_ids.h>
#include <kiway.h>

#include <google/protobuf/util/json_util.h>
#include <nlohmann/json.hpp>

#include <wx/dir.h>
#include <wx/filename.h>

#include <array>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <fstream>
#include <map>
#include <memory>
#include <span>
#include <string>
#include <vector>

#ifndef TRIAGE_EDA_ENGINE_VERSION
#define TRIAGE_EDA_ENGINE_VERSION "0.0.0"
#endif

namespace pb = triage::eda::v1;
using triage::hello::FrameType;

namespace TRIAGE
{

namespace
{

constexpr uint8_t FRAME_REQUEST = 0x20;
constexpr uint8_t FRAME_RESPONSE = 0x21;
constexpr uint8_t FRAME_DISPLAY_LIST = 0x22;

class HOST
{
public:
    explicit HOST( KIWAY& aKiway ) : m_kiway( aKiway ) {}

    /// Loads the faces on first use (loading a kiface takes a moment).
    std::vector<ENGINE_FACE*>& Faces()
    {
        if( !m_facesLoaded )
        {
            m_facesLoaded = true;

            for( KIWAY::FACE_T face : { KIWAY::FACE_PCB, KIWAY::FACE_SCH } )
            {
                if( KIFACE* kiface = m_kiway.KiFACE( face ) )
                {
                    if( void* address = kiface->IfaceOrAddress( KIFACE_TRIAGE_ENGINE ) )
                        m_faces.push_back( static_cast<ENGINE_FACE*>( address ) );
                }
            }
        }

        return m_faces;
    }

    void Handle( const pb::Request& aRequest, pb::Response& aResponse, const BULK_SINK& aBulk )
    {
        aResponse.set_id( aRequest.id() );

        try
        {
            dispatch( aRequest, aResponse, aBulk );
        }
        catch( const IO_ERROR& error )
        {
            aResponse.set_ok( false );
            aResponse.set_error( error.What().ToStdString() );
        }
        catch( const std::exception& error )
        {
            aResponse.set_ok( false );
            aResponse.set_error( std::string( "engine error: " ) + error.what() );
        }
        catch( ... )
        {
            aResponse.set_ok( false );
            aResponse.set_error( "engine error" );
        }
    }

private:
    static uint32_t documentOf( const pb::Request& aRequest )
    {
        switch( aRequest.command_case() )
        {
        case pb::Request::kCloseDocument: return aRequest.close_document().document();
        case pb::Request::kGetDisplayList: return aRequest.get_display_list().document();
        case pb::Request::kHitTest: return aRequest.hit_test().document();
        case pb::Request::kSetSelection: return aRequest.set_selection().document();
        case pb::Request::kGetNetlist: return aRequest.get_netlist().document();
        case pb::Request::kEdit: return aRequest.edit().document();
        case pb::Request::kUndo: return aRequest.undo().document();
        case pb::Request::kRedo: return aRequest.redo().document();
        case pb::Request::kSave: return aRequest.save().document();
        case pb::Request::kReload: return aRequest.reload().document();
        case pb::Request::kGetItems: return aRequest.get_items().document();
        case pb::Request::kHighlight: return aRequest.highlight().document();
        case pb::Request::kRoute: return aRequest.route().document();
        default: return 0;
        }
    }

    void dispatch( const pb::Request& aRequest, pb::Response& aResponse, const BULK_SINK& aBulk )
    {
        switch( aRequest.command_case() )
        {
        case pb::Request::kGetVersion:
        {
            pb::Version* version = aResponse.mutable_version();
            version->set_engine( EngineVersion() );
            version->set_kicad( GetBuildVersion().ToStdString() );

            for( ENGINE_FACE* face : Faces() )
                version->add_faces( face->Name() );

            aResponse.set_ok( true );
            return;
        }

        case pb::Request::kOpenDocument:
        {
            wxFileName file( wxString::FromUTF8( aRequest.open_document().path() ) );
            file.MakeAbsolute();
            const std::string path = file.GetFullPath().ToStdString( wxConvUTF8 );

            for( ENGINE_FACE* face : Faces() )
            {
                if( face->Accepts( path ) )
                {
                    const uint32_t id = m_nextDocument++;
                    face->Open( id, path, aResponse );

                    if( aResponse.ok() )
                        m_documents[id] = face;

                    return;
                }
            }

            aResponse.set_ok( false );
            aResponse.set_error( "no engine face opens " + path );
            return;
        }

        case pb::Request::COMMAND_NOT_SET:
            aResponse.set_ok( false );
            aResponse.set_error( "empty request" );
            return;

        default:
        {
            const uint32_t document = documentOf( aRequest );
            auto           it = m_documents.find( document );

            if( it == m_documents.end() )
            {
                aResponse.set_ok( false );
                aResponse.set_error( "no document " + std::to_string( document ) );
                return;
            }

            it->second->Handle( aRequest, aResponse, aBulk );

            if( aRequest.command_case() == pb::Request::kCloseDocument )
                m_documents.erase( it );

            return;
        }
        }
    }

    KIWAY&                           m_kiway;
    bool                             m_facesLoaded = false;
    std::vector<ENGINE_FACE*>        m_faces;
    std::map<uint32_t, ENGINE_FACE*> m_documents;
    uint32_t                         m_nextDocument = 1;
};


bool sendFrame( triage::hello::Connection& aConnection, uint8_t aType, const std::string& aPayload )
{
    std::array<std::byte, triage::hello::kFrameHeader> header{};
    triage::hello::encode_header( static_cast<FrameType>( aType ),
                                  static_cast<std::uint32_t>( aPayload.size() ), header );
    return aConnection.write_all( header.data(), header.size() )
           && ( aPayload.empty() || aConnection.write_all( aPayload.data(), aPayload.size() ) );
}


int serve( HOST& aHost, const std::string& aEndpoint )
{
    std::string error;
    auto        connection = triage::hello::connect_to( aEndpoint, 10000, error );

    if( !connection )
    {
        std::fprintf( stderr, "triage-eda-engine: %s\n", error.c_str() );
        return 2;
    }

    const std::string hello = EngineVersion() + " " + std::to_string( triage::hello::current_pid() );

    if( !sendFrame( *connection, static_cast<uint8_t>( FrameType::Hello ), hello ) )
        return 1;

    std::array<std::byte, triage::hello::kFrameHeader> header{};
    std::string                                        payload;
    bool                                               writeFailed = false;

    BULK_SINK bulk = [&]( std::string&& aChunk )
    {
        if( !writeFailed && !sendFrame( *connection, FRAME_DISPLAY_LIST, aChunk ) )
            writeFailed = true;
    };

    while( connection->read_exact( header.data(), header.size() ) )
    {
        FrameType  type{};
        const auto size = triage::hello::decode_header( header, type );

        if( !size )
        {
            sendFrame( *connection, static_cast<uint8_t>( FrameType::Error ), "invalid frame length" );
            return 3;
        }

        payload.resize( *size );

        if( *size > 0 && !connection->read_exact( payload.data(), *size ) )
            return 0;

        bool ok = true;

        switch( static_cast<uint8_t>( type ) )
        {
        case static_cast<uint8_t>( FrameType::Ping ):
            ok = sendFrame( *connection, static_cast<uint8_t>( FrameType::Pong ), payload );
            break;

        case FRAME_REQUEST:
        {
            pb::Request  request;
            pb::Response response;

            if( !request.ParseFromString( payload ) )
            {
                response.set_ok( false );
                response.set_error( "could not parse the request" );
            }
            else
            {
                aHost.Handle( request, response, bulk );
            }

            ok = !writeFailed && sendFrame( *connection, FRAME_RESPONSE, response.SerializeAsString() );
            break;
        }

        default:
            ok = sendFrame( *connection, static_cast<uint8_t>( FrameType::Error ), "unknown frame type" );
            break;
        }

        if( !ok )
            return 0; // the broker went away
    }

    return 0;
}


std::string toJson( const google::protobuf::Message& aMessage )
{
    std::string                             json;
    google::protobuf::util::JsonPrintOptions options;
    options.add_whitespace = true;
    options.preserve_proto_field_names = true;
    (void) google::protobuf::util::MessageToJsonString( aMessage, &json, options );
    return json;
}


/// Opens a document, builds its display list and asks for its netlist.
bool exercise( HOST& aHost, const std::string& aPath, std::string* aDisplayList,
               pb::Response* aInfo, pb::Response* aList, pb::Response* aNetlist )
{
    uint64_t    id = 1;
    BULK_SINK   bulk = [&]( std::string&& aChunk )
    {
        if( aDisplayList )
            aDisplayList->append( aChunk );
    };

    pb::Request open;
    open.set_id( id++ );
    open.mutable_open_document()->set_path( aPath );
    aHost.Handle( open, *aInfo, bulk );

    if( !aInfo->ok() )
        return false;

    const uint32_t doc = aInfo->document().document();

    pb::Request list;
    list.set_id( id++ );
    list.mutable_get_display_list()->set_document( doc );
    aHost.Handle( list, *aList, bulk );

    pb::Request net;
    net.set_id( id++ );
    net.mutable_get_netlist()->set_document( doc );
    aHost.Handle( net, *aNetlist, bulk );

    pb::Request  close;
    pb::Response closed;
    close.set_id( id++ );
    close.mutable_close_document()->set_document( doc );
    aHost.Handle( close, closed, bulk );

    return aList->ok() && aNetlist->ok();
}


int loadAll( HOST& aHost, const std::string& aDir )
{
    wxArrayString files;
    wxDir::GetAllFiles( wxString::FromUTF8( aDir ), &files, wxS( "*.kicad_pcb" ) );
    wxArrayString schematics;
    wxDir::GetAllFiles( wxString::FromUTF8( aDir ), &schematics, wxS( "*.kicad_sch" ) );

    // Root schematics only (named like their project); sub-sheets load with them.
    for( const wxString& file : schematics )
    {
        wxFileName project( file );
        project.SetExt( wxS( "kicad_pro" ) );

        if( project.FileExists() )
            files.Add( file );
    }

    files.Sort();
    int failures = 0;

    for( const wxString& file : files )
    {
        const auto   start = std::chrono::steady_clock::now();
        pb::Response info, list, netlist;
        const bool   ok = exercise( aHost, file.ToStdString( wxConvUTF8 ), nullptr, &info, &list,
                                    &netlist );
        const double ms = std::chrono::duration<double, std::milli>(
                                  std::chrono::steady_clock::now() - start )
                                  .count();

        // One JSON object per line: engines/eda/tests/ reads them. Built with a JSON
        // library: Windows paths have backslashes, errors may have quotes.
        nlohmann::json line;
        line["file"] = file.ToStdString( wxConvUTF8 );
        line["ok"] = ok;
        line["error"] = ok ? std::string()
                           : ( info.ok() ? list.ok() ? netlist.error() : list.error()
                                         : info.error() );
        line["groups"] = list.display_list().groups();
        line["bytes"] = static_cast<unsigned long long>( list.display_list().bytes() );
        line["components"] = netlist.netlist().components_size();
        line["nets"] = netlist.netlist().nets_size();
        line["ms"] = std::round( ms * 10.0 ) / 10.0;
        std::printf( "%s\n", line.dump( -1, ' ', false, nlohmann::json::error_handler_t::replace ).c_str() );
        std::fflush( stdout );

        if( !ok )
            failures++;
    }

    return failures == 0 ? 0 : 1;
}


int dump( HOST& aHost, const std::string& aFile, const std::string& aPrefix )
{
    std::string  displayList;
    pb::Response info, list, netlist;

    if( !exercise( aHost, aFile, &displayList, &info, &list, &netlist ) )
    {
        std::fprintf( stderr, "triage-eda-engine: %s\n",
                      ( info.ok() ? list.error() : info.error() ).c_str() );
        return 1;
    }

    std::ofstream( aPrefix + ".tdl", std::ios::binary ) << displayList;
    std::ofstream( aPrefix + ".info.json" ) << toJson( info );
    std::ofstream( aPrefix + ".list.json" ) << toJson( list );
    std::ofstream( aPrefix + ".netlist.json" ) << toJson( netlist );
    return 0;
}

} // namespace


std::string EngineVersion()
{
    return std::string( "triage-eda-engine " ) + TRIAGE_EDA_ENGINE_VERSION;
}


int RunHost( KIWAY& aKiway, int aArgc, char** aArgv )
{
    std::vector<std::string> args( aArgv + 1, aArgv + aArgc );
    HOST                     host( aKiway );

    auto value = [&]( const std::string& aFlag ) -> std::string
    {
        for( size_t i = 0; i + 1 < args.size(); ++i )
        {
            if( args[i] == aFlag )
                return args[i + 1];
        }

        return {};
    };

    if( const std::string endpoint = value( "--connect" ); !endpoint.empty() )
        return serve( host, endpoint );

    if( const std::string dir = value( "--load-all" ); !dir.empty() )
        return loadAll( host, dir );

    if( const std::string file = value( "--dump" ); !file.empty() )
    {
        const std::string out = value( "--out" );
        return dump( host, file, out.empty() ? file : out );
    }

    std::fprintf( stderr,
                  "usage: triage-eda-engine --version | --connect <endpoint> | --load-all <dir> |"
                  " --dump <file> [--out <prefix>]\n" );
    return 2;
}

} // namespace TRIAGE
