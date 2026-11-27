//! Sets up linking for a Node addon (napi-build). With MuJoCo, the addon finds
//! its library beside itself (`build.mjs` copies it there).
fn main() {
    napi_build::setup();
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    }
}
