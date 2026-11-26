//! Compiles the C shim and links MuJoCo, built from source by
//! `node engines/mujoco/build.mjs` (or found at `TRIAGE_MUJOCO_DIR`).
use std::env;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=shim/triage_mujoco.c");
    println!("cargo:rerun-if-env-changed=TRIAGE_MUJOCO_DIR");
    let root = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let os = match env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("windows") => "windows",
        Ok("macos") => "macos",
        _ => "linux",
    };
    let install = env::var_os("TRIAGE_MUJOCO_DIR").map_or_else(
        || {
            root.join("../../engines/mujoco/build")
                .join(os)
                .join("install")
        },
        PathBuf::from,
    );
    let include = install.join("include");
    println!("cargo::rustc-check-cfg=cfg(triage_no_mujoco)");
    println!("cargo:rerun-if-env-changed=TRIAGE_REQUIRE_MUJOCO");
    if !include.join("mujoco/mujoco.h").exists() {
        let message = format!(
            "MuJoCo isn't built: run `node engines/mujoco/build.mjs` (or set TRIAGE_MUJOCO_DIR); looked in {}",
            install.display()
        );
        assert!(
            env::var("TRIAGE_REQUIRE_MUJOCO").as_deref() != Ok("1"),
            "{message}"
        );
        // Without MuJoCo the crate builds, World::new says why it can't, and the
        // tests are skipped: `cargo test --workspace` works on any machine.
        println!("cargo:warning={message}; triage-mujoco is built without it");
        println!("cargo:rustc-cfg=triage_no_mujoco");
        println!(
            "cargo:rerun-if-changed={}",
            include.join("mujoco/mujoco.h").display()
        );
        return;
    }
    cc::Build::new()
        .file("shim/triage_mujoco.c")
        .include(&include)
        .compile("triage_mujoco_shim");
    let lib = install.join("lib");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rustc-link-lib=dylib=mujoco");
    // Tests and the sim addon find the library at run time: the addon's build
    // copies it beside itself; tests get the install folder.
    println!("cargo:root={}", install.display());
    if os == "linux" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{}", lib.display());
    }
}
