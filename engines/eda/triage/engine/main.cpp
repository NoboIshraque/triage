/*
 * triage-eda-engine: Triage's EDA engine host (ROADMAP P1-2, PLAN §4.2).
 * GPL-3.0-or-later.
 *
 * A long-running headless process modelled on kicad-cli (kicad/kicad_cli.cpp):
 * a console wx application with KiCad's program object and a KIWAY that loads
 * the pcbnew and eeschema kifaces. It connects to its broker the way the P0-4
 * hello engine does (--connect <endpoint>: a Unix socket, or a named pipe on
 * Windows) and answers triage.eda.v1 requests until the broker goes away.
 *
 *   triage-eda-engine --version
 *   triage-eda-engine --connect <endpoint>
 *   triage-eda-engine --load-all <dir>                    every board and schematic under dir
 *   triage-eda-engine --dump <file> --out <prefix>        display list + info, for goldens
 *                                                         (boards: + <prefix>.board3d.json)
 */

#include "host.h"

#include <kiway.h>
#include <libraries/library_manager.h>
#include <paths.h>
#include <pgm_base.h>
#include <settings/kicad_settings.h>
#include <settings/settings_manager.h>
#include <bin_mod.h>
#include <kiplatform/app.h>
#include <kiplatform/environment.h>
#include <thread_pool.h>
#include <git/git_backend.h>
#include <git/libgit_backend.h>
#include <kiface_base.h>

#include <wx/app.h>
#include <wx/log.h>

#include <cstdio>
#include <stdexcept>
#include <string>
#include <vector>

KIWAY Kiway( KFCTL_CPP_PROJECT_SUITE | KFCTL_CLI );


// As in kicad-cli: referenced from EDA_BASE_FRAME::config(), never called.
KIFACE_BASE& Kiface()
{
    wxLogFatalError( wxT( "Unexpected call to Kiface() in triage-eda-engine" ) );
    throw std::logic_error( "Unexpected call to Kiface() in triage-eda-engine" );
}


PROJECT& Prj()
{
    return Kiway.Prj();
}


namespace
{

class PGM_TRIAGE_ENGINE : public PGM_BASE
{
public:
    PGM_TRIAGE_ENGINE() : m_bm( "kicad" ) {}

    ~PGM_TRIAGE_ENGINE() noexcept override { Destroy(); }

    bool OnPgmInit()
    {
        PGM_BASE::BuildArgvUtf8();
        App().SetAppDisplayName( wxT( "triage-eda-engine" ) );

        SetGitBackend( new LIBGIT_BACKEND() );
        GetGitBackend()->Init();

        // Headless, without Python (kicad-cli does the same).
        if( !InitPgm( true, true ) )
            return false;

        m_bm.InitSettings( new KICAD_SETTINGS );
        GetSettingsManager().RegisterSettings( m_bm.m_config );
        GetSettingsManager().SetKiway( &Kiway );
        m_bm.Init();

        GetLibraryManager().LoadGlobalTables();
        return true;
    }

    int OnPgmRun() { return TRIAGE::RunHost( Kiway, m_argcUtf8, m_argvUtf8 ); }

    void OnPgmExit()
    {
        GetKiCadThreadPool().purge();
        GetKiCadThreadPool().wait();

        Kiway.OnKiwayEnd();

        if( m_settings_manager && m_settings_manager->IsOK() )
            m_settings_manager->Save();

        if( GetGitBackend() )
        {
            GetGitBackend()->Shutdown();
            delete GetGitBackend();
            SetGitBackend( nullptr );
        }

        Destroy();
    }

    void MacOpenFile( const wxString& aFileName ) override { (void) aFileName; }

    void Destroy()
    {
        m_bm.End();
        PGM_BASE::Destroy();
    }

private:
    BIN_MOD m_bm;
};


PGM_TRIAGE_ENGINE program;


struct APP_TRIAGE_ENGINE : public wxAppConsole
{
    APP_TRIAGE_ENGINE() : wxAppConsole()
    {
        SetPgm( &program );
        KIPLATFORM::ENV::Init();
    }

    bool OnInit() override
    {
        // --version answers before KiCad starts (the CMake test and the broker use it).
        for( int i = 1; i < argc; ++i )
        {
            if( wxString( argv[i] ) == wxS( "--version" ) )
            {
                std::printf( "%s\n", TRIAGE::EngineVersion().c_str() );
                m_versionOnly = true;
                return true;
            }
        }

        if( !KIPLATFORM::APP::Init() )
            return false;

        if( !program.OnPgmInit() )
        {
            program.OnPgmExit();
            return false;
        }

        return true;
    }

    int OnRun() override
    {
        if( m_versionOnly )
            return 0;

        try
        {
            return program.OnPgmRun();
        }
        catch( ... )
        {
            Pgm().HandleException( std::current_exception() );
        }

        return 1;
    }

    int OnExit() override
    {
        int ret = wxAppConsole::OnExit();

        if( !m_versionOnly )
            program.OnPgmExit();

        return ret;
    }

    int FilterEvent( wxEvent& aEvent ) override
    {
        (void) aEvent;
        return Event_Skip;
    }

    bool m_versionOnly = false;
};

} // namespace


IMPLEMENT_APP_CONSOLE( APP_TRIAGE_ENGINE )
