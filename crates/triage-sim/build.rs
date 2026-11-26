//! With the `mujoco` feature, lets this crate's tests find MuJoCo's library.
fn main() {
    println!("cargo:rerun-if-env-changed=DEP_MUJOCO_ROOT");
    if let Ok(root) = std::env::var("DEP_MUJOCO_ROOT")
        && std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux")
    {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{root}/lib");
    }
}
