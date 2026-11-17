// SPDX-License-Identifier: MIT
//
// Links SDL3, the one library besides the system's: the flags
// `pkg-config --static --libs sdl3` gives (the static build the CI makes, or
// an installed one), or SDL3_LIBS (the same kind of flags) when set.
use std::process::Command;

fn main() {
    println!("cargo:rerun-if-env-changed=SDL3_LIBS");
    println!("cargo:rerun-if-env-changed=PKG_CONFIG_PATH");
    let flags = match std::env::var("SDL3_LIBS") {
        Ok(f) => f,
        Err(_) => {
            let out = Command::new("pkg-config").args(["--static", "--libs", "sdl3"]).output();
            match out {
                Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).into_owned(),
                _ => "-lSDL3".to_string(),
            }
        }
    };
    // deep pages lay out deep (the WebAssembly build has a 32 MB stack): the
    // main thread gets 64 MB on macOS, where the window has to live on it
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-stack_size,0x4000000");
    }
    let mut it = flags.split_whitespace().peekable();
    while let Some(f) = it.next() {
        if let Some(p) = f.strip_prefix("-L") {
            println!("cargo:rustc-link-search=native={}", p);
        } else if let Some(l) = f.strip_prefix("-l") {
            // (the SDL3 archive itself statically, the system's libraries as they are)
            if l == "SDL3" && flags.contains("-L") { println!("cargo:rustc-link-lib=static=SDL3"); } else { println!("cargo:rustc-link-lib={}", l); }
        } else if f == "-framework" {
            if let Some(n) = it.next() { println!("cargo:rustc-link-lib=framework={}", n); }
        } else if f.starts_with("-Wl,-weak_framework,") {
            println!("cargo:rustc-link-arg={}", f);
        } else if f == "-pthread" {
            println!("cargo:rustc-link-arg=-pthread");
        } else {
            println!("cargo:rustc-link-arg={}", f);
        }
    }
}
