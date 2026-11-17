// SPDX-License-Identifier: MIT
//
// The few SDL3 functions the window uses, declared by hand (no binding
// crate): a window, its 2D renderer (Metal on macOS, OpenGL/Direct3D or
// software elsewhere), triangles with colours and textures, and events.
#![allow(non_camel_case_types, dead_code)]

use std::ffi::{c_char, c_int, c_void};

pub type Window = c_void;
pub type Renderer = c_void;
pub type Texture = c_void;
pub type Surface = c_void;

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Vertex {
    pub x: f32,
    pub y: f32,
    pub r: f32,
    pub g: f32,
    pub b: f32,
    pub a: f32,
    pub u: f32,
    pub v: f32,
}

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct Rect {
    pub x: c_int,
    pub y: c_int,
    pub w: c_int,
    pub h: c_int,
}

/// SDL_Event is a 128-byte union; fields are read at their offsets.
#[repr(C, align(8))]
pub struct Event {
    pub raw: [u8; 128],
}

impl Event {
    pub fn new() -> Event { Event { raw: [0; 128] } }
    pub fn kind(&self) -> u32 { self.u32(0) }
    pub fn u32(&self, o: usize) -> u32 { u32::from_ne_bytes(self.raw[o..o + 4].try_into().unwrap()) }
    pub fn i32(&self, o: usize) -> i32 { self.u32(o) as i32 }
    pub fn u16(&self, o: usize) -> u16 { u16::from_ne_bytes(self.raw[o..o + 2].try_into().unwrap()) }
    pub fn f32(&self, o: usize) -> f32 { f32::from_ne_bytes(self.raw[o..o + 4].try_into().unwrap()) }
    pub fn ptr(&self, o: usize) -> *const c_char { usize::from_ne_bytes(self.raw[o..o + std::mem::size_of::<usize>()].try_into().unwrap()) as *const c_char }
}

pub const INIT_VIDEO: u32 = 0x20;
pub const WINDOW_RESIZABLE: u64 = 0x20;
pub const WINDOW_HIDDEN: u64 = 0x8;
pub const WINDOW_HIGH_PIXEL_DENSITY: u64 = 0x2000;
pub const PIXELFORMAT_ABGR8888: u32 = 0x16762004; // bytes R,G,B,A on little endian
pub const TEXTUREACCESS_STATIC: c_int = 0;
pub const BLENDMODE_BLEND: u32 = 1;

pub const EVENT_QUIT: u32 = 0x100;
pub const EVENT_WINDOW_RESIZED: u32 = 0x206;
pub const EVENT_WINDOW_PIXEL_SIZE_CHANGED: u32 = 0x207;
pub const EVENT_WINDOW_MOUSE_LEAVE: u32 = 0x20D;
pub const EVENT_WINDOW_DISPLAY_SCALE_CHANGED: u32 = 0x214;
pub const EVENT_KEY_DOWN: u32 = 0x300;
pub const EVENT_KEY_UP: u32 = 0x301;
pub const EVENT_TEXT_INPUT: u32 = 0x303;
pub const EVENT_MOUSE_MOTION: u32 = 0x400;
pub const EVENT_MOUSE_BUTTON_DOWN: u32 = 0x401;
pub const EVENT_MOUSE_BUTTON_UP: u32 = 0x402;
pub const EVENT_MOUSE_WHEEL: u32 = 0x403;

pub const KMOD_SHIFT: u16 = 0x0003;
pub const KMOD_CTRL: u16 = 0x00c0;
pub const KMOD_ALT: u16 = 0x0300;
pub const KMOD_GUI: u16 = 0x0c00;

pub const SYSTEM_CURSOR_DEFAULT: c_int = 0;
pub const SYSTEM_CURSOR_TEXT: c_int = 1;
pub const SYSTEM_CURSOR_POINTER: c_int = 11;

extern "C" {
    pub fn SDL_Init(flags: u32) -> bool;
    pub fn SDL_Quit();
    pub fn SDL_GetError() -> *const c_char;
    pub fn SDL_SetHint(name: *const c_char, value: *const c_char) -> bool;
    pub fn SDL_CreateWindow(title: *const c_char, w: c_int, h: c_int, flags: u64) -> *mut Window;
    pub fn SDL_SetWindowTitle(w: *mut Window, title: *const c_char) -> bool;
    pub fn SDL_GetWindowSize(w: *mut Window, x: *mut c_int, y: *mut c_int) -> bool;
    pub fn SDL_GetWindowSizeInPixels(w: *mut Window, x: *mut c_int, y: *mut c_int) -> bool;
    pub fn SDL_CreateRenderer(w: *mut Window, name: *const c_char) -> *mut Renderer;
    pub fn SDL_GetRendererName(r: *mut Renderer) -> *const c_char;
    pub fn SDL_SetRenderVSync(r: *mut Renderer, vsync: c_int) -> bool;
    pub fn SDL_SetRenderScale(r: *mut Renderer, x: f32, y: f32) -> bool;
    pub fn SDL_SetRenderDrawBlendMode(r: *mut Renderer, mode: u32) -> bool;
    pub fn SDL_SetRenderDrawColor(r: *mut Renderer, cr: u8, cg: u8, cb: u8, ca: u8) -> bool;
    pub fn SDL_RenderClear(r: *mut Renderer) -> bool;
    pub fn SDL_RenderPresent(r: *mut Renderer) -> bool;
    pub fn SDL_SetRenderClipRect(r: *mut Renderer, rect: *const Rect) -> bool;
    pub fn SDL_RenderGeometry(r: *mut Renderer, t: *mut Texture, v: *const Vertex, nv: c_int, idx: *const c_int, ni: c_int) -> bool;
    pub fn SDL_CreateTexture(r: *mut Renderer, fmt: u32, access: c_int, w: c_int, h: c_int) -> *mut Texture;
    pub fn SDL_UpdateTexture(t: *mut Texture, rect: *const Rect, pixels: *const c_void, pitch: c_int) -> bool;
    pub fn SDL_SetTextureBlendMode(t: *mut Texture, mode: u32) -> bool;
    pub fn SDL_DestroyTexture(t: *mut Texture);
    pub fn SDL_RenderReadPixels(r: *mut Renderer, rect: *const Rect) -> *mut Surface;
    pub fn SDL_SaveBMP(s: *mut Surface, file: *const c_char) -> bool;
    pub fn SDL_DestroySurface(s: *mut Surface);
    pub fn SDL_PollEvent(e: *mut Event) -> bool;
    pub fn SDL_WaitEventTimeout(e: *mut Event, ms: i32) -> bool;
    pub fn SDL_StartTextInput(w: *mut Window) -> bool;
    pub fn SDL_GetTicks() -> u64;
    pub fn SDL_CreateSystemCursor(id: c_int) -> *mut c_void;
    pub fn SDL_SetCursor(c: *mut c_void) -> bool;
    pub fn SDL_GetBasePath() -> *const c_char;
    pub fn SDL_GetClipboardText() -> *mut c_char;
    pub fn SDL_free(p: *mut c_void);
}

pub fn cstr(s: &str) -> std::ffi::CString { std::ffi::CString::new(s.replace('\0', "")).unwrap() }

pub fn error() -> String {
    unsafe { std::ffi::CStr::from_ptr(SDL_GetError()).to_string_lossy().into_owned() }
}
