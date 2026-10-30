//! Live liquid glass, drawn inside the dock's own window.
//!
//! The dock page is transparent wherever the glass shows. Behind the page, in the same window, a
//! DirectComposition visual holds a Direct3D 11 swap chain with real per-pixel alpha. Desktop
//! Duplication hands us the screen as a GPU texture; the dock window is excluded from capture, so
//! the glass sees what is behind the dock and never itself. A pixel shader treats every capsule and
//! popover as a lens:
//!   - refraction that bends hardest at the rim, with slight colour dispersion there,
//!   - frost (blur) set by Clarity, and a tint that deepens when the background would make text hard to read,
//!   - continuous (squircle) corners, anti-aliased edges and a soft drop shadow,
//!   - a rim lit from the top-left, and a glint that follows the mouse pointer across the glass.
//!
//! Nothing is redrawn while the screen behind the dock and the pointer stay still.
use std::mem::size_of;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use windows::core::{s, Interface, Result, PCSTR};
use windows::Win32::Foundation::{E_FAIL, HWND, POINT, RECT};
use windows::Win32::Graphics::Direct3D::Fxc::{D3DCompile, D3DCOMPILE_OPTIMIZATION_LEVEL3};
use windows::Win32::Graphics::Direct3D::{ID3DBlob, D3D_DRIVER_TYPE_UNKNOWN, D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST};
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::DirectComposition::{DCompositionCreateDevice, IDCompositionDevice, IDCompositionTarget, IDCompositionVisual};
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::UI::WindowsAndMessaging::{GetCursorPos, GetWindowRect, IsWindowVisible, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WDA_NONE};

pub const MAX_SHAPES: usize = 32;

/// One glass shape in the dock window's physical pixels: x, y, width, height, corner radius,
/// kind (0 = capsule, 1 = panel: more frost and tint, so text on it stays readable), opacity.
pub type Shape = [f32; 7];

#[derive(Default)]
pub struct Shared {
    pub enabled: bool,
    /// Frost radius, physical px.
    pub frost: f32,
    /// Physical px per CSS px, so the lens keeps its size at any display scale.
    pub scale: f32,
    /// Continuous (superellipse) corners, matching CSS `corner-shape: squircle`.
    pub squircle: bool,
    /// Theme tint: rgb, and how strongly it is applied.
    pub tint: [f32; 4],
    pub shapes: Vec<Shape>,
    pub version: u64,
    pub snapshot: Option<PathBuf>,
}

pub struct Glass {
    pub state: Mutex<Shared>,
    pub status: Mutex<String>,
    log: PathBuf,
}

impl Glass {
    /// Status changes and errors go to glass.log in the app data folder (Live glass can't be screenshotted).
    fn note(&self, line: &str) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
            let _ = writeln!(f, "{t} {line}");
        }
    }
}

pub fn start(dock: isize, data_dir: PathBuf) -> Arc<Glass> {
    let log = data_dir.join("glass.log");
    let _ = std::fs::write(&log, "");
    let g = Arc::new(Glass { state: Mutex::default(), status: Mutex::new("off".into()), log });
    let g2 = g.clone();
    std::thread::spawn(move || run(g2, HWND(dock as _)));
    g
}

/* ---------- shader ---------- */

const HLSL: &str = r#"
cbuffer P : register(b0) {
  float2 win; float2 capOff;
  float2 capSize; float blurPx; float strength;
  float count; float power; float2 cursor;
  float hover; float3 pad;
  float4 tint;
  float4 shapes[32]; float4 extra[32];   // extra: radius, kind, opacity
};
Texture2D cap : register(t0);
SamplerState smp : register(s0);
struct V { float4 pos : SV_Position; };

V vs(uint id : SV_VertexID) {
  V o; float2 uv = float2((id << 1) & 2, id & 2);
  o.pos = float4(uv * float2(2, -2) + float2(-1, 1), 0, 1);
  return o;
}
// Rounded box whose corners are superellipses |x|^n + |y|^n = r^n:
// n = 4 matches CSS corner-shape: squircle, n = 2 is a plain circular corner.
float sdShape(float2 p, float4 s, float r) {
  float2 h = s.zw * 0.5;
  r = min(r, min(h.x, h.y));
  float2 q = abs(p - (s.xy + h)) - h + r;
  float2 m = max(q, 0);
  float k = power > 2.5 ? pow(pow(m.x, power) + pow(m.y, power), 1.0 / power) : length(m);
  return k + min(max(q.x, q.y), 0) - r;
}
float3 tap(float2 px) { return cap.SampleLevel(smp, (px + capOff) / capSize, 0).rgb; }
float3 frost(float2 px, float rad) {
  if (rad < 0.5) return tap(px);
  float3 acc = 0; float wsum = 0;
  [unroll] for (int i = 0; i < 16; i++) {            // golden-angle disc
    float a = i * 2.39996;
    float rr = sqrt((i + 0.5) / 16.0) * rad;
    float w = 1.0 - 0.5 * rr / rad;
    acc += tap(px + float2(cos(a), sin(a)) * rr) * w; wsum += w;
  }
  return acc / wsum;
}
float luma(float3 c) { return dot(c, float3(0.2126, 0.7152, 0.0722)); }

float4 ps(V i) : SV_Target {
  float2 p = i.pos.xy;
  float best = 1e9, shade = 0; int k = -1;
  for (int s = 0; s < (int)count; s++) {
    float4 sh = shapes[s];
    // cheap reject: farther than the shadow reaches from this shape's box
    float2 gap = max(max(sh.xy - p, p - (sh.xy + sh.zw)), 0);
    if (max(gap.x, gap.y) > 28.0) continue;
    float d = sdShape(p, sh, extra[s].x);
    if (d < best) { best = d; k = s; }
    float sd = max(sdShape(p - float2(0, 3.5), sh, extra[s].x), 0);   // cast a little downward
    shade = max(shade, extra[s].z * (0.16 * exp(-sd / 7.0) + 0.10 * exp(-sd / 1.8)));
  }
  if (k < 0 || best > 1.0) return float4(0, 0, 0, shade);

  float4 sh = shapes[k]; float r = extra[k].x; bool panel = extra[k].y > 0.5; float op = extra[k].z;
  float2 n = normalize(float2(sdShape(p + float2(1, 0), sh, r) - sdShape(p - float2(1, 0), sh, r),
                              sdShape(p + float2(0, 1), sh, r) - sdShape(p - float2(0, 1), sh, r)) + 1e-5);
  float depth = -best;                                   // px inside the edge
  float bezel = panel ? 26.0 : clamp(min(sh.z, sh.w) * 0.42, 6.0, 22.0);
  float t = saturate(depth / bezel);
  float edge = pow(1.0 - t, 2.2);
  float2 centre = sh.xy + sh.zw * 0.5;
  // lens: light bends hardest at the rim; the middle is gently magnified
  float2 off = -n * strength * (panel ? 1.35 : 1.0) * edge + (centre - p) * (panel ? 0.012 : 0.035);
  float3 col = frost(p + off, blurPx * (panel ? 2.6 : 1.0));
  float ca = 0.30 * edge;                                 // colour dispersion, rim only
  col.r = lerp(col.r, tap(p + off * (1.0 + ca)).r, edge * 0.65);
  col.b = lerp(col.b, tap(p + off * (1.0 - ca)).b, edge * 0.65);
  col = lerp(luma(col).xxx, col, 1.18);                   // a touch richer, like real glass

  // adaptive tint: look at what is behind the whole shape and deepen the tint when text on top
  // of it would be hard to read (bright backgrounds under dark glass, dark ones under light glass)
  float3 avg = 0;
  [unroll] for (int a = 0; a < 3; a++) [unroll] for (int b = 0; b < 3; b++)
    avg += tap(sh.xy + sh.zw * float2(0.2 + 0.3 * a, 0.2 + 0.3 * b));
  float L = luma(avg / 9.0), tl = luma(tint.rgb);
  float need = tl > 0.5 ? saturate((0.62 - L) * 1.2) : saturate((L - 0.40) * 1.2);
  float amount = ((panel ? 0.42 : 0.12) + need * (panel ? 0.24 : 0.34)) * tint.a;
  col = lerp(col, tint.rgb, saturate(amount));

  // light: a thin bright rim, keyed from the top-left with a softer fill from the bottom-right
  float rim = 1.0 - smoothstep(0.0, 2.2, depth);
  float band = pow(1.0 - t, 4.0);
  float key = saturate(dot(n, normalize(float2(-0.6, -0.8))));
  float fill = saturate(dot(n, normalize(float2(0.6, 0.8))));
  col += rim * (0.08 + 0.50 * key + 0.22 * fill);
  col += band * (0.20 * key * key + 0.06 * fill);
  // the pointer: a soft glint on the glass and a brighter rim near it
  float pd = length(p - cursor);
  float glint = hover * exp(-pd * pd / (2.0 * 64.0 * 64.0));
  col += glint * (0.07 + 0.30 * band + 0.55 * rim);

  float cover = saturate(0.5 - best) * op;
  return float4(saturate(col) * cover, cover + (1.0 - cover) * shade);
}
"#;

#[repr(C)]
#[derive(Clone, Copy)]
struct Params {
    win: [f32; 2],
    cap_off: [f32; 2],
    cap_size: [f32; 2],
    blur: f32,
    strength: f32,
    count: f32,
    power: f32,
    cursor: [f32; 2],
    hover: f32,
    pad: [f32; 3],
    tint: [f32; 4],
    shapes: [[f32; 4]; MAX_SHAPES],
    extra: [[f32; 4]; MAX_SHAPES],
}

fn compile(entry: PCSTR, target: PCSTR) -> Result<Vec<u8>> {
    let mut code: Option<ID3DBlob> = None;
    let mut errors: Option<ID3DBlob> = None;
    let r = unsafe {
        D3DCompile(HLSL.as_ptr() as _, HLSL.len(), PCSTR::null(), None, None, entry, target, D3DCOMPILE_OPTIMIZATION_LEVEL3, 0, &mut code, Some(&mut errors))
    };
    if let Err(e) = r {
        let msg = errors.map(|b| unsafe { String::from_utf8_lossy(std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize())).into_owned() });
        return Err(windows::core::Error::new(e.code(), msg.unwrap_or_default()));
    }
    let b = code.ok_or_else(|| windows::core::Error::new(E_FAIL, "no shader"))?;
    Ok(unsafe { std::slice::from_raw_parts(b.GetBufferPointer() as *const u8, b.GetBufferSize()).to_vec() })
}

fn fail(msg: &str) -> windows::core::Error {
    windows::core::Error::new(E_FAIL, msg)
}

/* ---------- renderer ---------- */

#[derive(Clone, Copy, PartialEq)]
enum Change {
    None,
    Pointer, // only the mouse pointer moved
    Inside,
    Outside,
}

/// How far outside a shape the lens samples (refraction offset plus frost).
const LENS_REACH: i32 = 40;

fn contains(r: &RECT, x: i32, y: i32) -> bool {
    x >= r.left && x < r.right && y >= r.top && y < r.bottom
}
fn overlaps(a: &RECT, b: &RECT) -> bool {
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

struct Renderer {
    device: ID3D11Device,
    ctx: ID3D11DeviceContext,
    vs: ID3D11VertexShader,
    ps: ID3D11PixelShader,
    cb: ID3D11Buffer,
    smp: ID3D11SamplerState,
    raster: ID3D11RasterizerState,
    factory: IDXGIFactory2,
    dcomp: IDCompositionDevice,
    target: IDCompositionTarget,
    visual: IDCompositionVisual,
    dup: IDXGIOutputDuplication,
    out_rect: RECT, // desktop coordinates of the monitor being duplicated
    desk: Option<(ID3D11Texture2D, ID3D11ShaderResourceView)>,
    swap: Option<IDXGISwapChain1>,
    rtv: Option<ID3D11RenderTargetView>,
    size: (u32, u32),
}

impl Drop for Renderer {
    fn drop(&mut self) {
        // Take the glass out of the dock window (Live glass turned off, or the renderer is being rebuilt).
        unsafe {
            let _ = self.target.SetRoot(None);
            let _ = self.dcomp.Commit();
        }
    }
}

impl Renderer {
    /// Device on the GPU that drives the monitor the dock is on (Desktop Duplication needs that),
    /// and a composition target behind the dock page's child windows.
    fn new(dock: HWND, at: (i32, i32)) -> Result<Self> {
        unsafe {
            let f1: IDXGIFactory1 = CreateDXGIFactory1()?;
            let (mut found, mut i) = (None, 0);
            'scan: while let Ok(adapter) = f1.EnumAdapters1(i) {
                let mut j = 0;
                while let Ok(o) = adapter.EnumOutputs(j) {
                    let d = o.GetDesc()?;
                    if d.AttachedToDesktop.as_bool() && contains(&d.DesktopCoordinates, at.0, at.1) {
                        found = Some((adapter.clone(), o, d.DesktopCoordinates));
                        break 'scan;
                    }
                    j += 1;
                }
                i += 1;
            }
            let (adapter, output, out_rect) = found.ok_or_else(|| fail("no monitor under the dock"))?;
            let (mut device, mut ctx) = (None, None);
            D3D11CreateDevice(&adapter.cast::<IDXGIAdapter>()?, D3D_DRIVER_TYPE_UNKNOWN, Default::default(), D3D11_CREATE_DEVICE_BGRA_SUPPORT, None, D3D11_SDK_VERSION, Some(&mut device), None, Some(&mut ctx))?;
            let device: ID3D11Device = device.ok_or_else(|| fail("no device"))?;
            let dup = output.cast::<IDXGIOutput1>()?.DuplicateOutput(&device)?;

            let (vsb, psb) = (compile(s!("vs"), s!("vs_5_0"))?, compile(s!("ps"), s!("ps_5_0"))?);
            let (mut vs, mut ps) = (None, None);
            device.CreateVertexShader(&vsb, None, Some(&mut vs))?;
            device.CreatePixelShader(&psb, None, Some(&mut ps))?;
            let mut cb = None;
            device.CreateBuffer(
                &D3D11_BUFFER_DESC { ByteWidth: size_of::<Params>() as u32, Usage: D3D11_USAGE_DEFAULT, BindFlags: D3D11_BIND_CONSTANT_BUFFER.0 as u32, ..Default::default() },
                None,
                Some(&mut cb),
            )?;
            let mut smp = None;
            device.CreateSamplerState(
                &D3D11_SAMPLER_DESC {
                    Filter: D3D11_FILTER_MIN_MAG_MIP_LINEAR,
                    AddressU: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressV: D3D11_TEXTURE_ADDRESS_CLAMP,
                    AddressW: D3D11_TEXTURE_ADDRESS_CLAMP,
                    ComparisonFunc: D3D11_COMPARISON_NEVER,
                    MaxLOD: f32::MAX,
                    ..Default::default()
                },
                Some(&mut smp),
            )?;
            // Scissor: only the pixels near a shape get shaded.
            let mut raster = None;
            device.CreateRasterizerState(
                &D3D11_RASTERIZER_DESC { FillMode: D3D11_FILL_SOLID, CullMode: D3D11_CULL_NONE, ScissorEnable: true.into(), DepthClipEnable: true.into(), ..Default::default() },
                Some(&mut raster),
            )?;

            let dcomp: IDCompositionDevice = DCompositionCreateDevice(&device.cast::<IDXGIDevice>()?)?;
            let target = dcomp.CreateTargetForHwnd(dock, false)?; // behind the page
            let visual = dcomp.CreateVisual()?;
            target.SetRoot(&visual)?;
            Ok(Renderer {
                factory: f1.cast()?,
                device,
                ctx: ctx.ok_or_else(|| fail("no context"))?,
                vs: vs.ok_or_else(|| fail("no vertex shader"))?,
                ps: ps.ok_or_else(|| fail("no pixel shader"))?,
                cb: cb.ok_or_else(|| fail("no constant buffer"))?,
                smp: smp.ok_or_else(|| fail("no sampler"))?,
                raster: raster.ok_or_else(|| fail("no rasterizer state"))?,
                dcomp,
                target,
                visual,
                dup,
                out_rect,
                desk: None,
                swap: None,
                rtv: None,
                size: (0, 0),
            })
        }
    }

    /// A swap chain the size of the dock window, with real alpha, shown behind the page.
    fn fit(&mut self, r: &RECT) -> Result<()> {
        let (w, h) = ((r.right - r.left).max(1) as u32, (r.bottom - r.top).max(1) as u32);
        if self.swap.is_some() && self.size == (w, h) {
            return Ok(());
        }
        unsafe {
            self.rtv = None;
            match &self.swap {
                Some(swap) => swap.ResizeBuffers(0, w, h, DXGI_FORMAT_UNKNOWN, DXGI_SWAP_CHAIN_FLAG(0))?,
                None => {
                    let desc = DXGI_SWAP_CHAIN_DESC1 {
                        Width: w,
                        Height: h,
                        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
                        SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
                        BufferUsage: DXGI_USAGE_RENDER_TARGET_OUTPUT,
                        BufferCount: 2,
                        SwapEffect: DXGI_SWAP_EFFECT_FLIP_SEQUENTIAL,
                        AlphaMode: DXGI_ALPHA_MODE_PREMULTIPLIED,
                        Scaling: DXGI_SCALING_STRETCH,
                        ..Default::default()
                    };
                    let swap = self.factory.CreateSwapChainForComposition(&self.device, &desc, None)?;
                    self.visual.SetContent(&swap)?;
                    self.dcomp.Commit()?;
                    self.swap = Some(swap);
                }
            }
            let swap = self.swap.as_ref().ok_or_else(|| fail("no swap chain"))?;
            let back: ID3D11Texture2D = swap.GetBuffer(0)?;
            let mut rtv = None;
            self.device.CreateRenderTargetView(&back, None, Some(&mut rtv))?;
            self.rtv = rtv;
        }
        self.size = (w, h);
        Ok(())
    }

    /// Takes the newest screen frame if one arrived, and says where it changed relative to the dock.
    /// `take_inside`: copy the frame even when it only changed inside the dock (a refresh is due).
    fn capture(&mut self, dock: &RECT, timeout_ms: u32, take_inside: bool) -> Result<Change> {
        let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
        let mut res: Option<IDXGIResource> = None;
        match unsafe { self.dup.AcquireNextFrame(timeout_ms, &mut info, &mut res) } {
            Err(e) if e.code() == DXGI_ERROR_WAIT_TIMEOUT => return Ok(Change::None),
            Err(e) => return Err(e),
            Ok(()) => {}
        }
        let result = (|| -> Result<Change> {
            let change = if self.desk.is_none() {
                Change::Outside
            } else if info.LastPresentTime == 0 {
                Change::Pointer
            } else {
                self.classify(&info, dock)
            };
            if matches!(change, Change::None | Change::Pointer) || (change == Change::Inside && !take_inside) {
                return Ok(change);
            }
            let frame: ID3D11Texture2D = res.as_ref().ok_or_else(|| fail("no frame"))?.cast()?;
            unsafe {
                if self.desk.is_none() {
                    let mut d = D3D11_TEXTURE2D_DESC::default();
                    frame.GetDesc(&mut d);
                    d.Usage = D3D11_USAGE_DEFAULT;
                    d.BindFlags = D3D11_BIND_SHADER_RESOURCE.0 as u32;
                    d.CPUAccessFlags = 0;
                    d.MiscFlags = 0;
                    let mut tex = None;
                    self.device.CreateTexture2D(&d, None, Some(&mut tex))?;
                    let tex = tex.ok_or_else(|| fail("no texture"))?;
                    let mut srv = None;
                    self.device.CreateShaderResourceView(&tex, None, Some(&mut srv))?;
                    self.desk = Some((tex, srv.ok_or_else(|| fail("no view"))?));
                }
                if let Some((tex, _)) = &self.desk {
                    self.ctx.CopyResource(tex, &frame);
                }
            }
            Ok(change)
        })();
        unsafe {
            let _ = self.dup.ReleaseFrame();
        }
        result
    }

    /// Where this frame changed. The dock window is left out of the captured image, but Windows
    /// still reports its repaints as changes inside its rectangle; redrawing on those would feed
    /// back into itself every frame. So a change contained in the dock's rectangle is `Inside`
    /// (refreshed at most once a second), and one that reaches past it is `Outside` (a window
    /// moving or a video playing behind the dock: redraw now).
    fn classify(&self, info: &DXGI_OUTDUPL_FRAME_INFO, dock: &RECT) -> Change {
        if info.TotalMetadataBufferSize == 0 {
            return Change::Outside;
        }
        let o = &self.out_rect;
        let own = RECT { left: dock.left - o.left - 1, top: dock.top - o.top - 1, right: dock.right - o.left + 1, bottom: dock.bottom - o.top + 1 };
        let reach = RECT { left: own.left - LENS_REACH, top: own.top - LENS_REACH, right: own.right + LENS_REACH, bottom: own.bottom + LENS_REACH };
        let mut rects: Vec<RECT> = vec![];
        let bytes = info.TotalMetadataBufferSize;
        unsafe {
            let mut used = 0u32;
            let mut dirty = vec![RECT::default(); bytes as usize / size_of::<RECT>() + 1];
            if self.dup.GetFrameDirtyRects(bytes, dirty.as_mut_ptr(), &mut used).is_ok() {
                rects.extend_from_slice(&dirty[..used as usize / size_of::<RECT>()]);
            }
            let mut moves = vec![DXGI_OUTDUPL_MOVE_RECT::default(); bytes as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>() + 1];
            if self.dup.GetFrameMoveRects(bytes, moves.as_mut_ptr(), &mut used).is_ok() {
                rects.extend(moves[..used as usize / size_of::<DXGI_OUTDUPL_MOVE_RECT>()].iter().map(|m| m.DestinationRect));
            }
        }
        let mut change = Change::None;
        for r in rects.iter().filter(|r| overlaps(r, &reach)) {
            if r.left >= own.left && r.top >= own.top && r.right <= own.right && r.bottom <= own.bottom {
                change = Change::Inside;
            } else {
                return Change::Outside;
            }
        }
        change
    }

    fn render(&mut self, dock: &RECT, st: &Frame, snapshot: Option<&PathBuf>) -> Result<()> {
        let (Some(swap), Some(rtv), Some((_, srv))) = (&self.swap, &self.rtv, &self.desk) else { return Ok(()) };
        let o = &self.out_rect;
        let mut p = Params {
            win: [self.size.0 as f32, self.size.1 as f32],
            cap_off: [(dock.left - o.left) as f32, (dock.top - o.top) as f32],
            cap_size: [(o.right - o.left) as f32, (o.bottom - o.top) as f32],
            blur: st.frost,
            strength: 11.0 * st.scale,
            count: st.shapes.len().min(MAX_SHAPES) as f32,
            power: if st.squircle { 4.0 } else { 2.0 },
            cursor: st.cursor,
            hover: st.hover,
            pad: [0.0; 3],
            tint: st.tint,
            shapes: [[0.0; 4]; MAX_SHAPES],
            extra: [[0.0; 4]; MAX_SHAPES],
        };
        // Shade only near the shapes (the shadow reaches about 28 px); the rest stays clear.
        let mut sc = RECT { left: i32::MAX, top: i32::MAX, right: i32::MIN, bottom: i32::MIN };
        for (i, s) in st.shapes.iter().take(MAX_SHAPES).enumerate() {
            p.shapes[i] = [s[0], s[1], s[2], s[3]];
            p.extra[i] = [s[4], s[5], s[6], 0.0];
            sc.left = sc.left.min(s[0] as i32 - 32);
            sc.top = sc.top.min(s[1] as i32 - 32);
            sc.right = sc.right.max((s[0] + s[2]) as i32 + 32);
            sc.bottom = sc.bottom.max((s[1] + s[3]) as i32 + 36);
        }
        unsafe {
            let c = &self.ctx;
            c.ClearRenderTargetView(rtv, &[0.0, 0.0, 0.0, 0.0]);
            if !st.shapes.is_empty() {
                c.UpdateSubresource(&self.cb, 0, None, &p as *const _ as _, 0, 0);
                c.OMSetRenderTargets(Some(&[Some(rtv.clone())]), None);
                c.RSSetViewports(Some(&[D3D11_VIEWPORT { TopLeftX: 0.0, TopLeftY: 0.0, Width: p.win[0], Height: p.win[1], MinDepth: 0.0, MaxDepth: 1.0 }]));
                c.RSSetState(&self.raster);
                c.RSSetScissorRects(Some(&[sc]));
                c.IASetPrimitiveTopology(D3D_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
                c.VSSetShader(&self.vs, None);
                c.PSSetShader(&self.ps, None);
                c.PSSetShaderResources(0, Some(&[Some(srv.clone())]));
                c.PSSetSamplers(0, Some(&[Some(self.smp.clone())]));
                c.PSSetConstantBuffers(0, Some(&[Some(self.cb.clone())]));
                c.Draw(3, 0);
            }
            if let Some(path) = snapshot {
                let _ = self.save(path);
            }
            swap.Present(1, DXGI_PRESENT(0)).ok()
        }
    }

    /// Writes the rendered glass to a PNG (for checking the shader; Live glass is hidden from screen capture).
    fn save(&self, path: &PathBuf) -> Result<()> {
        unsafe {
            let back: ID3D11Texture2D = self.swap.as_ref().ok_or_else(|| fail("no swap chain"))?.GetBuffer(0)?;
            let mut d = D3D11_TEXTURE2D_DESC::default();
            back.GetDesc(&mut d);
            d.Usage = D3D11_USAGE_STAGING;
            d.BindFlags = 0;
            d.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
            d.MiscFlags = 0;
            let mut st = None;
            self.device.CreateTexture2D(&d, None, Some(&mut st))?;
            let st = st.ok_or_else(|| fail("no staging texture"))?;
            self.ctx.CopyResource(&st, &back);
            let mut m = D3D11_MAPPED_SUBRESOURCE::default();
            self.ctx.Map(&st, 0, D3D11_MAP_READ, 0, Some(&mut m))?;
            let mut px = Vec::with_capacity((d.Width * d.Height * 4) as usize);
            for y in 0..d.Height {
                let row = std::slice::from_raw_parts((m.pData as *const u8).add((y * m.RowPitch) as usize), (d.Width * 4) as usize);
                for c in row.as_chunks::<4>().0 {
                    // premultiplied BGRA -> straight RGBA
                    let a = c[3] as u32;
                    let un = |v: u8| (v as u32 * 255 + a / 2).checked_div(a).map_or(0, |x| x.min(255) as u8);
                    px.extend_from_slice(&[un(c[2]), un(c[1]), un(c[0]), c[3]]);
                }
            }
            self.ctx.Unmap(&st, 0);
            // written beside the target and renamed, so a reader never sees half a file
            let part = path.with_extension("part");
            let file = std::fs::File::create(&part).map_err(|e| fail(&e.to_string()))?;
            let mut enc = png::Encoder::new(std::io::BufWriter::new(file), d.Width, d.Height);
            enc.set_color(png::ColorType::Rgba);
            enc.set_depth(png::BitDepth::Eight);
            enc.write_header().and_then(|mut w| w.write_image_data(&px)).map_err(|e| fail(&e.to_string()))?;
            std::fs::rename(&part, path).map_err(|e| fail(&e.to_string()))
        }
    }
}

/// What one render needs, copied out of the shared state.
struct Frame {
    shapes: Vec<Shape>,
    frost: f32,
    scale: f32,
    squircle: bool,
    tint: [f32; 4],
    cursor: [f32; 2],
    hover: f32,
}

/* ---------- loop ---------- */

fn run(g: Arc<Glass>, dock: HWND) {
    let set = |s: String| {
        let mut st = g.status.lock().unwrap();
        if *st != s {
            g.note(&s);
            *st = s;
        }
    };
    // For checking the shader: LEOBAR_GLASS_SNAPSHOT=<file.png> saves the first rendered frame.
    let mut auto_snap = std::env::var_os("LEOBAR_GLASS_SNAPSHOT").map(PathBuf::from);
    // For checking the composition on screen: LEOBAR_GLASS_DEBUG=1 freezes the captured screen after
    // the first frame and lets screenshots see the dock (otherwise the glass would refract itself).
    let debug = std::env::var_os("LEOBAR_GLASS_DEBUG").is_some();
    let mut frozen = false;

    let mut r: Option<Renderer> = None;
    let (mut was_on, mut seen, mut last) = (false, u64::MAX, RECT::default());
    let (mut busy_until, mut last_render, mut inside_pending) = (Instant::now(), Instant::now(), false);
    let (mut hover, mut cursor) = (0.0f32, [-1e4f32, -1e4]);
    loop {
        let (on, version, mut frame, snap) = {
            let mut s = g.state.lock().unwrap();
            let f = Frame { shapes: s.shapes.clone(), frost: s.frost, scale: s.scale.max(1.0), squircle: s.squircle, tint: s.tint, cursor, hover };
            (s.enabled, s.version, f, s.snapshot.take())
        };
        if on != was_on {
            unsafe {
                // The dock is left out of capture only while Live glass needs it.
                let _ = SetWindowDisplayAffinity(dock, if on && !frozen { WDA_EXCLUDEFROMCAPTURE } else { WDA_NONE });
            }
            if !on {
                r = None; // takes the glass out of the window
            }
            was_on = on;
            seen = u64::MAX;
            last = RECT::default();
            set(if on { "starting".into() } else { "off".into() });
        }
        let visible = unsafe { IsWindowVisible(dock).as_bool() };
        if !on || !visible {
            std::thread::sleep(Duration::from_millis(80));
            continue;
        }

        let mut rect = RECT::default();
        if unsafe { GetWindowRect(dock, &mut rect) }.is_err() {
            std::thread::sleep(Duration::from_millis(80));
            continue;
        }
        let centre = ((rect.left + rect.right) / 2, (rect.bottom - 4).max(rect.top));
        if r.as_ref().is_some_and(|x| !contains(&x.out_rect, centre.0, centre.1)) {
            r = None; // moved to another monitor
        }
        if r.is_none() {
            match Renderer::new(dock, centre) {
                Ok(x) => {
                    r = Some(x);
                    set("live".into());
                    seen = u64::MAX;
                    last = RECT::default();
                }
                Err(e) => {
                    set(format!("error: {}", e.message()));
                    std::thread::sleep(Duration::from_millis(1500));
                    continue;
                }
            }
        }
        let Some(ren) = r.as_mut() else { continue };
        let mut need = false;
        if rect != last {
            if let Err(e) = ren.fit(&rect) {
                set(format!("error: {}", e.message()));
                r = None;
                continue;
            }
            last = rect;
            need = true;
            busy_until = Instant::now() + Duration::from_millis(500);
        }
        if version != seen {
            seen = version;
            need = true;
            busy_until = Instant::now() + Duration::from_millis(500);
        }

        // The pointer: the glint follows it over the glass and fades out when it leaves.
        let mut pt = POINT::default();
        let over = unsafe { GetCursorPos(&mut pt) }.is_ok() && contains(&rect, pt.x, pt.y) && {
            let (x, y) = ((pt.x - rect.left) as f32, (pt.y - rect.top) as f32);
            frame.shapes.iter().any(|s| x > s[0] - 40.0 && x < s[0] + s[2] + 40.0 && y > s[1] - 40.0 && y < s[1] + s[3] + 40.0)
        };
        if over {
            let c = [(pt.x - rect.left) as f32, (pt.y - rect.top) as f32];
            if c != cursor {
                cursor = c;
                need = true;
            }
        }
        let goal = if over { 1.0 } else { 0.0 };
        if hover != goal {
            hover += (goal - hover) * 0.22;
            if (goal - hover).abs() < 0.02 {
                hover = goal;
            }
            need = true;
        }
        if need && (over || hover > 0.0) {
            busy_until = busy_until.max(Instant::now() + Duration::from_millis(120));
        }
        frame.cursor = cursor;
        frame.hover = hover;

        let busy = Instant::now() < busy_until;
        if !frozen {
            let refresh_due = last_render.elapsed() >= Duration::from_secs(1);
            match ren.capture(&rect, if busy { 4 } else { 50 }, refresh_due) {
                Ok(Change::Outside) => need = true,
                Ok(Change::Inside) => {
                    inside_pending = true;
                    if !busy && !refresh_due {
                        std::thread::sleep(Duration::from_millis(45)); // the dock's own repaints: check less often
                    }
                }
                Ok(Change::Pointer) => {
                    if !busy {
                        std::thread::sleep(Duration::from_millis(16)); // pointer frames arrive at mouse rate: don't spin on them
                    }
                }
                Ok(Change::None) => {}
                Err(e) if e.code() == DXGI_ERROR_ACCESS_LOST => {
                    r = None; // resolution change, lock screen, UAC: start the duplication again
                    continue;
                }
                Err(e) => {
                    set(format!("error: {}", e.message()));
                    r = None;
                    std::thread::sleep(Duration::from_millis(500));
                    continue;
                }
            }
            // Changes inside the dock's own rectangle are mostly the dock's own repaints: refresh for
            // them at most once a second, so something small changing right behind it still shows.
            if inside_pending && refresh_due {
                need = true;
                inside_pending = false;
            }
            if debug && ren.desk.is_some() {
                frozen = true;
                unsafe {
                    let _ = SetWindowDisplayAffinity(dock, WDA_NONE);
                }
                set("live (debug: capture frozen, dock visible to screenshots)".into());
            }
        } else {
            std::thread::sleep(Duration::from_millis(if busy { 8 } else { 40 }));
        }

        let Some(ren) = r.as_mut() else { continue };
        let snap = snap.or_else(|| if ren.desk.is_some() { auto_snap.take() } else { None });
        if need || snap.is_some() {
            last_render = Instant::now();
            if let Err(e) = ren.render(&rect, &frame, snap.as_ref()) {
                set(format!("error: {}", e.message()));
                r = None;
            }
        }
    }
}
