//! DataRefine Studio — Tauri v2 desktop shell.
//! Spawns the local data engine beside the window. Never block first paint.

use std::fs;
use std::io::Read;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{Manager, RunEvent, State};

mod app;
mod cloud;
mod ai;
mod plugins;

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    spawned_here: Mutex<bool>,
    last_error: Mutex<String>,
    python: Mutex<String>,
    port: Mutex<u16>,
}

impl Sidecar {
    fn new() -> Self {
        Self {
            child: Mutex::new(None),
            spawned_here: Mutex::new(false),
            last_error: Mutex::new(String::new()),
            python: Mutex::new(String::new()),
            port: Mutex::new(17831),
        }
    }
}

#[derive(serde::Serialize)]
struct SidecarStatus {
    running: bool,
    python: String,
    error: String,
    log: String,
    port: u16,
}

fn looks_like_resource_root(path: &Path) -> bool {
    path.join("sidecar").join("main.py").is_file()
        || path.join("libraries").join("builtin-rules.json").is_file()
        || path.join("plugins").is_dir()
}

pub(crate) fn project_root() -> PathBuf {
    if let Ok(env) = std::env::var("DATAREFINE_ROOT") {
        let p = PathBuf::from(env);
        if p.is_dir() {
            return p;
        }
    }
    let baked = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut candidates = Vec::new();
    // Tauri places configured resources beside the installed executable.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("datarefine"));
            candidates.push(dir.join("resources"));
            candidates.push(dir.to_path_buf());
            candidates.push(dir.join(".."));
            candidates.push(dir.join("../.."));
        }
    }
    candidates.push(baked);
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.clone());
        if let Some(p) = cwd.parent() {
            candidates.push(p.to_path_buf());
        }
    }
    for c in candidates {
        let p = c.canonicalize().unwrap_or(c);
        if looks_like_resource_root(&p) {
            return p;
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) fn data_root() -> PathBuf {
    if cfg!(debug_assertions) {
        return project_root();
    }
    if let Ok(env) = std::env::var("DATAREFINE_DATA") {
        let p = PathBuf::from(env);
        let _ = fs::create_dir_all(&p);
        return p;
    }
    let base = if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA").map(PathBuf::from)
    } else if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
        Some(PathBuf::from(xdg))
    } else {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".local").join("share"))
    }
    .unwrap_or_else(|| project_root());
    let path = base.join("DataRefine Studio");
    let _ = fs::create_dir_all(&path);
    path
}

fn sidecar_script() -> PathBuf {
    let root = project_root();
    let from_src = root.join("sidecar").join("main.py");
    if from_src.is_file() {
        return from_src;
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for rel in ["sidecar/main.py", "../sidecar/main.py", "../../sidecar/main.py"] {
                let p = dir.join(rel);
                if p.is_file() {
                    return p;
                }
            }
        }
    }
    from_src
}

fn bundled_engine() -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("resources").join("datarefine-engine.exe"));
            candidates.push(dir.join("datarefine-engine.exe"));
        }
    }
    let root = project_root();
    candidates.push(root.join("datarefine-engine.exe"));
    if let Some(parent) = root.parent() {
        candidates.push(parent.join("resources").join("datarefine-engine.exe"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// Runtime-only files (Python cache, sidecar log and selected port) are kept
/// outside the installed Program Files tree. User data is never uninstalled
/// by the NSIS bundle.
fn runtime_dir() -> PathBuf {
    let dir = data_root().join("runtime");
    let _ = fs::create_dir_all(&dir);
    dir
}

fn cache_path() -> PathBuf {
    runtime_dir().join("python-cmd.txt")
}

fn log_path() -> PathBuf {
    runtime_dir().join("sidecar.log")
}

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(80),
    )
    .is_ok()
}

fn pick_free_port() -> u16 {
    for p in 17831u16..17841 {
        if TcpListener::bind(("127.0.0.1", p)).is_ok() {
            return p;
        }
    }
    17831
}

fn apply_no_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let _ = cmd;
}

fn is_store_stub(path: &str) -> bool {
    let p = path.replace('/', "\\").to_ascii_lowercase();
    p.contains("\\windowsapps\\")
}

fn run_python(bin: &str, extra: &[String], code: &str, timeout_ms: u64) -> Option<String> {
    if bin.is_empty() {
        return None;
    }
    if is_store_stub(bin) {
        return None;
    }
    let mut cmd = Command::new(bin);
    cmd.args(extra)
        .args(["-c", code])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    apply_no_window(&mut cmd);
    let mut child = cmd.spawn().ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut buf = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut buf);
                }
                let text = buf.trim().to_string();
                if is_store_stub(&text) {
                    return None;
                }
                return Some(text);
            }
            Ok(None) => {
                if start.elapsed() > Duration::from_millis(timeout_ms) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(40));
            }
            Err(_) => return None,
        }
    }
}

fn py_meta(bin: &str, extra: &[String]) -> Option<(u32, String)> {
    let out = run_python(
        bin,
        extra,
        "import sys; print(f'{sys.version_info[0]}.{sys.version_info[1]}|{sys.executable}')",
        2500,
    )?;
    let mut parts = out.splitn(2, '|');
    let ver = parts.next().unwrap_or("");
    let exe = parts.next().unwrap_or("").trim().to_string();
    let mut v = ver.split('.');
    let major: u32 = v.next()?.parse().ok()?;
    let minor: u32 = v.next()?.parse().ok()?;
    if major != 3 {
        return None;
    }
    if exe.is_empty() || is_store_stub(&exe) {
        return None;
    }
    Some((minor, exe))
}

fn preferred(minor: u32) -> bool {
    matches!(minor, 11 | 12 | 13 | 14)
}

fn read_cache() -> Option<(String, Vec<String>)> {
    let raw = fs::read_to_string(cache_path()).ok()?;
    let mut lines = raw
        .lines()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let bin = lines.next()?;
    let extra: Vec<String> = lines.collect();
    Some((bin, extra))
}

fn write_cache(bin: &str, extra: &[String]) {
    let mut body = String::from(bin);
    for a in extra {
        body.push('\n');
        body.push_str(a);
    }
    let _ = fs::write(cache_path(), body);
}

fn py_launchers() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(root) = std::env::var("SystemRoot") {
        out.push(format!("{}\\py.exe", root));
        out.push(format!("{}\\System32\\py.exe", root));
    }
    out.push("py".into());
    out
}

fn py_installed() -> Vec<PathBuf> {
    let mut exes = Vec::new();
    for launcher in py_launchers() {
        let mut cmd = Command::new(&launcher);
        cmd.args(["-0p"]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
        apply_no_window(&mut cmd);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                if let Ok(s) = String::from_utf8(out.stdout) {
                    for line in s.lines() {
                        let path = line
                            .split_whitespace()
                            .find(|t| {
                                let l = t.to_ascii_lowercase();
                                (l.contains("python") || l.ends_with(".exe")) && (t.contains('\\') || t.contains('/'))
                            });
                        if let Some(p) = path {
                            let p = p.trim().trim_matches('"');
                            if p.to_ascii_lowercase().ends_with("python.exe") || Path::new(p).is_file() {
                                if !is_store_stub(p) {
                                    exes.push(PathBuf::from(p));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    exes
}

fn disk_pythons() -> Vec<PathBuf> {
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(la).join("Programs").join("Python"));
    }
    if let Ok(home) = std::env::var("USERPROFILE") {
        roots.push(
            PathBuf::from(&home)
                .join("AppData")
                .join("Local")
                .join("Programs")
                .join("Python"),
        );
        roots.push(PathBuf::from(&home).join("AppData").join("Local").join("Programs").join("Python"));
    }
    if let Ok(pf) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(pf));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(pf86));
    }
    roots.push(PathBuf::from("C:\\"));
    let mut exes = Vec::new();
    for ver in [
        "Python312",
        "Python311",
        "Python313",
        "Python314",
        "Python3.12",
        "Python3.11",
        "Python3.13",
        "Python3.14",
        "Python312-64",
        "Python311-64",
        "Python313-64",
        "Python314-64",
    ] {
        for root in &roots {
            let p = root.join(ver).join("python.exe");
            if p.is_file() {
                exes.push(p);
            }
        }
        exes.push(PathBuf::from(format!("C:\\{ver}\\python.exe")));
    }
    if let Ok(la) = std::env::var("LOCALAPPDATA") {
        let root = PathBuf::from(la).join("Programs").join("Python");
        if let Ok(rd) = fs::read_dir(root) {
            for e in rd.flatten() {
                let p = e.path().join("python.exe");
                if p.is_file() {
                    exes.push(p);
                }
            }
        }
    }
    exes
}

fn consider(bin: &str, extra: &[String], preferred_only: bool) -> Option<(String, Vec<String>, u32)> {
    let (minor, exe) = py_meta(bin, extra)?;
    if preferred_only && !preferred(minor) {
        return None;
    }
    if minor < 11 {
        return None;
    }
    Some((exe, vec![], minor))
}

fn pick_python() -> Result<(String, Vec<String>), String> {
    if let Ok(env) = std::env::var("DATAREFINE_PYTHON") {
        let env = env.trim().to_string();
        if !env.is_empty() {
            if let Some((exe, extra, _)) = consider(&env, &[], false) {
                write_cache(&exe, &extra);
                return Ok((exe, extra));
            }
            return Ok((env, vec![]));
        }
    }
    if let Some((bin, extra)) = read_cache() {
        // The cache stores the resolved executable path. Trust an existing
        // preferred interpreter instead of launching Python just to re-check
        // its version on every app start.
        if Path::new(&bin).is_file() && !is_store_stub(&bin) {
            return Ok((bin, extra));
        }
        if let Some((exe, ex, minor)) = consider(&bin, &extra, true) {
            if preferred(minor) {
                write_cache(&exe, &ex);
                return Ok((exe, ex));
            }
        }
    }

    let mut found: Vec<(String, Vec<String>, u32)> = Vec::new();
    let mut push = |hit: Option<(String, Vec<String>, u32)>| {
        if let Some(h) = hit {
            if !found.iter().any(|(e, _, _)| e.eq_ignore_ascii_case(&h.0)) {
                found.push(h);
            }
        }
    };

    for p in py_installed().into_iter().chain(disk_pythons()) {
        let s = p.to_string_lossy().into_owned();
        push(consider(&s, &[], true));
    }

    let launcher_args: Vec<Vec<String>> = vec![
        vec!["-3.12".into()],
        vec!["-3.11".into()],
        vec!["-3.13".into()],
        vec!["-3.14".into()],
    ];
    for launcher in py_launchers() {
        for extra in &launcher_args {
            push(consider(&launcher, extra, true));
        }
    }

    for bin in ["python3.12", "python3.11", "python3.13", "python3.14", "python312", "python311", "python313", "python314"] {
        push(consider(bin, &[], true));
    }

    found.sort_by_key(|(_, _, minor)| match *minor {
        12 => 0,
        11 => 1,
        13 => 2,
        14 => 3,
        _ => 9,
    });
    if let Some((exe, extra, _)) = found.into_iter().next() {
        write_cache(&exe, &extra);
        return Ok((exe, extra));
    }

    for (bin, extra) in [
        ("python", vec![]),
        ("python3", vec![]),
        ("py", vec!["-3".into()]),
    ] {
        if let Some((exe, ex, minor)) = consider(bin, &extra, false) {
            if minor >= 11 {
                write_cache(&exe, &ex);
                return Ok((exe, ex));
            }
        }
    }

    Err(
        "Python 3.11–3.14 not found. Install from https://www.python.org/downloads/ (check “Add python.exe to PATH”), then: py -3.12 -m pip install -r requirements.txt"
            .into(),
    )
}

fn append_log(line: &str) {
    let path = log_path();
    let mut body = fs::read_to_string(&path).unwrap_or_default();
    if body.len() > 200_000 {
        body = body[body.len() - 80_000..].to_string();
    }
    body.push_str(line);
    if !line.ends_with('\n') {
        body.push('\n');
    }
    let _ = fs::write(path, body);
}

fn spawn_sidecar() -> Result<(Child, String, u16), String> {
    let root = project_root();
    let data = data_root();
    let port = pick_free_port();
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path())
        .map_err(|e| format!("cannot write sidecar.log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| e.to_string())?;

    if let Some(engine) = bundled_engine() {
        append_log(&format!(
            "\n---- spawn bundled engine {}  port={}  resources={}  data={} ----",
            engine.display(),
            port,
            root.display(),
            data.display()
        ));
        let mut cmd = Command::new(&engine);
        cmd.current_dir(&data)
            .env("DATAREFINE_PORT", port.to_string())
            .env("DATAREFINE_ROOT", &root)
            .env("DATAREFINE_DATA", &data)
            .env("PYTHONUNBUFFERED", "1")
            .env("PYTHONUTF8", "1")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log))
            .stderr(Stdio::from(log_err));
        apply_no_window(&mut cmd);
        return cmd
            .spawn()
            .map(|child| (child, engine.to_string_lossy().into_owned(), port))
            .map_err(|e| format!("could not start bundled DataRefine engine: {e}"));
    }

    let script = sidecar_script();
    if !script.is_file() {
        return Err(format!(
            "bundled DataRefine engine is missing and sidecar source is unavailable at {}",
            script.display()
        ));
    }
    let python_root = script
        .parent()
        .and_then(Path::parent)
        .map(PathBuf::from)
        .unwrap_or_else(|| root.clone());
    let (bin, extra) = pick_python()?;
    let mut args = extra.clone();
    args.push(script.to_string_lossy().into_owned());

    append_log(&format!(
        "\n---- spawn Python {} {}  port={}  resources={}  data={} ----",
        bin,
        extra.join(" "),
        port,
        python_root.display(),
        data.display()
    ));

    let mut cmd = Command::new(&bin);
    cmd.args(&args)
        .current_dir(&data)
        .env("DATAREFINE_PORT", port.to_string())
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("DATAREFINE_ROOT", &python_root)
        .env("DATAREFINE_DATA", &data)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(log_err));
    apply_no_window(&mut cmd);

    match cmd.spawn() {
        Ok(child) => Ok((child, bin, port)),
        Err(e) => Err(format!(
            "could not start Python ({bin}: {e}). Install Python 3.11–3.14 and add it to PATH."
        )),
    }
}

fn kill_child(state: &Sidecar) {
    if let Ok(mut g) = state.child.lock() {
        if let Some(mut child) = g.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
    if let Ok(mut f) = state.spawned_here.lock() {
        *f = false;
    }
}

fn start_into(state: &Sidecar) -> Result<(), String> {
    let known = state.port.lock().map(|g| *g).unwrap_or(17831);
    for _ in 0..8 {
        if port_open(known) {
            let _ = state.last_error.lock().map(|mut g| g.clear());
            return Ok(());
        }
        for p in 17831u16..17841 {
            if p != known && port_open(p) {
                if let Ok(mut g) = state.port.lock() {
                    *g = p;
                }
                let _ = state.last_error.lock().map(|mut g| g.clear());
                return Ok(());
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    match spawn_sidecar() {
        Ok((child, python, port)) => {
            if let Ok(mut g) = state.child.lock() {
                *g = Some(child);
            }
            if let Ok(mut f) = state.spawned_here.lock() {
                *f = true;
            }
            if let Ok(mut p) = state.port.lock() {
                *p = port;
            }
            if let Ok(mut py) = state.python.lock() {
                *py = python;
            }
            if let Ok(mut e) = state.last_error.lock() {
                e.clear();
            }
            let _ = fs::write(runtime_dir().join("engine-port.txt"), port.to_string());
            Ok(())
        }
        Err(err) => {
            if err == "already-running" {
                return Ok(());
            }
            append_log(&format!("ERROR {err}"));
            if let Ok(mut e) = state.last_error.lock() {
                *e = err.clone();
            }
            Err(err)
        }
    }
}

fn wait_until_up(state: &Sidecar, ms: u64) -> bool {
    let start = Instant::now();
    while start.elapsed() < Duration::from_millis(ms) {
        let port = state.port.lock().map(|g| *g).unwrap_or(17831);
        if port_open(port) {
            return true;
        }
        if let Ok(mut g) = state.child.lock() {
            if let Some(child) = g.as_mut() {
                if let Ok(Some(status)) = child.try_wait() {
                    let msg = format!(
                        "DataRefine engine exited ({status}). See {}.",
                        log_path().display()
                    );
                    append_log(&msg);
                    if let Ok(mut e) = state.last_error.lock() {
                        *e = msg;
                    }
                    *g = None;
                    return false;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    false
}

fn read_log_tail() -> String {
    let raw = fs::read_to_string(log_path()).unwrap_or_default();
    let tail = if raw.len() > 4000 { &raw[raw.len() - 4000..] } else { &raw };
    tail.trim().to_string()
}

fn status_of(state: &Sidecar) -> SidecarStatus {
    let mut port = state.port.lock().map(|g| *g).unwrap_or(17831);
    let mut running = port_open(port);
    if !running {
        for p in 17831u16..17841 {
            if port_open(p) {
                port = p;
                running = true;
                if let Ok(mut g) = state.port.lock() {
                    *g = p;
                }
                break;
            }
        }
    }
    SidecarStatus {
        running,
        python: state.python.lock().map(|g| g.clone()).unwrap_or_default(),
        error: state.last_error.lock().map(|g| g.clone()).unwrap_or_default(),
        log: read_log_tail(),
        port,
    }
}

#[tauri::command]
fn sidecar_status(state: State<Sidecar>) -> SidecarStatus {
    status_of(&state)
}

#[tauri::command]
fn sidecar_restart(state: State<Sidecar>) -> SidecarStatus {
    kill_child(&state);
    std::thread::sleep(Duration::from_millis(250));
    let _ = start_into(&state);
    let _ = wait_until_up(&state, 25000);
    status_of(&state)
}

const NATIVE_POPUP_GUARD: &str = r#"
(function () {
  try {
    // Install before the bundled page scripts. Tauri/WebView2 must never
    // create a second native window for window.open, including about:blank.
    window.open = function () { return null; };
  } catch (_) {}
})();
"#;

/// Create the only application window in Rust so Tauri's native new-window
/// handler is installed before any page JavaScript can run. The `create: false`
/// config entry keeps the original window appearance and resource URL while
/// preventing Tauri from constructing the window before this handler exists.
fn build_main_window(app: &tauri::AppHandle) -> tauri::Result<tauri::WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("main window configuration is missing");

    tauri::WebviewWindowBuilder::from_config(app, config)?
        .initialization_script(NATIVE_POPUP_GUARD)
        .on_navigation(|url| {
            let line = format!("desktop navigation url={url}");
            append_log(&line);
            eprintln!("[DataRefine Studio][navigation] {url}");
            true
        })
        .on_page_load(|window, payload| {
            let line = format!("desktop page-load window={} url={}", window.label(), payload.url());
            append_log(&line);
            eprintln!(
                "[DataRefine Studio][page-load] window={} url={}",
                window.label(),
                payload.url()
            );
        })
        .on_new_window(|url, _features| {
            let line = format!("desktop blocked-new-window url={url}");
            append_log(&line);
            eprintln!(
                "[DataRefine Studio][blocked-new-window] url={url} — denying native child WebView"
            );
            if url.scheme() == "https" {
                let _ = crate::app::policy::commands::license_open_url(url.to_string());
            }
            tauri::webview::NewWindowResponse::Deny
        })
        .build()
}

fn main_window(app: &tauri::AppHandle) -> Result<tauri::WebviewWindow, String> {
    app.get_webview_window("main").ok_or_else(|| "window missing".into())
}

#[tauri::command]
fn win_minimize(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn win_toggle_maximize(app: tauri::AppHandle) -> Result<(), String> {
    let w = main_window(&app)?;
    if w.is_maximized().unwrap_or(false) {
        w.unmaximize().map_err(|e| e.to_string())
    } else {
        w.maximize().map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn win_close(app: tauri::AppHandle) -> Result<(), String> {
    main_window(&app)?.close().map_err(|e| e.to_string())
}

#[tauri::command]
fn save_download_file(filename: String, bytes: Vec<u8>) -> Result<String, String> {
    let home = if cfg!(windows) {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    } else {
        std::env::var_os("HOME").map(PathBuf::from)
    }
    .unwrap_or_else(|| data_root());
    let dir = home.join("Downloads");
    fs::create_dir_all(&dir).map_err(|e| format!("could not create Downloads folder: {e}"))?;

    let raw = Path::new(filename.trim())
        .file_name()
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_else(|| "datarefine-download".to_string());
    let safe: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ' | '(' | ')') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.trim().is_empty() {
        "datarefine-download".to_string()
    } else {
        safe
    };
    let parsed = Path::new(&safe);
    let stem = parsed
        .file_stem()
        .map(|v| v.to_string_lossy().into_owned())
        .unwrap_or_else(|| "datarefine-download".to_string());
    let ext = parsed
        .extension()
        .map(|v| format!(".{}", v.to_string_lossy()))
        .unwrap_or_default();

    let mut target = dir.join(&safe);
    let mut n = 1u32;
    while target.exists() {
        target = dir.join(format!("{stem} ({n}){ext}"));
        n = n.saturating_add(1);
    }
    fs::write(&target, bytes).map_err(|e| format!("could not save download: {e}"))?;
    Ok(pretty_path(&target))
}

#[tauri::command]
fn open_path(path: String) -> Result<bool, String> {
    crate::app::policy::commands::entitlement_ok()?;
    let raw = pretty_path_str(path.trim());
    if raw.is_empty() {
        return Err("empty path".into());
    }
    let p = PathBuf::from(&raw);
    let abs = if p.is_absolute() {
        p
    } else {
        let user_path = data_root().join(&p);
        if user_path.exists() {
            user_path
        } else {
            project_root().join(p)
        }
    };
    let abs = abs.canonicalize().unwrap_or(abs);
    if !abs.exists() {
        return Err(format!("file not found: {}", pretty_path(&abs)));
    }
    let s = pretty_path(&abs);
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", &s])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_no_window(&mut cmd);
        cmd.spawn().map_err(|e| format!("could not open {s}: {e}"))?;
        return Ok(true);
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&s)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not open {s}: {e}"))?;
        return Ok(true);
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(&s)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not open {s}: {e}"))?;
        Ok(true)
    }
}

#[derive(serde::Serialize)]
struct TermResult {
    cwd: String,
    stdout: String,
    stderr: String,
    code: i32,
    shell: String,
}

#[derive(serde::Serialize)]
struct TermCwd {
    cwd: String,
    shell: String,
}

fn term_shell() -> String {
    if cfg!(windows) {
        "powershell".into()
    } else {
        "bash".into()
    }
}

fn pretty_path_str(s: &str) -> String {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        return rest.to_string();
    }
    s.to_string()
}

fn pretty_path(p: &Path) -> String {
    pretty_path_str(&p.to_string_lossy())
}

fn home_dir() -> PathBuf {
    std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| data_root())
}

fn resolve_cwd(cwd: &str) -> PathBuf {
    let raw = pretty_path_str(cwd.trim());
    let p = PathBuf::from(&raw);
    if !raw.is_empty() && p.is_dir() {
        return p;
    }
    data_root()
}

fn engine_python() -> Option<String> {
    if let Some((bin, _)) = read_cache() {
        if !bin.is_empty() {
            return Some(bin);
        }
    }
    std::env::var("DATAREFINE_PYTHON")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn python_path_dirs(exe: &str) -> Vec<PathBuf> {
    let p = PathBuf::from(exe);
    let dir = p.parent().map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."));
    let mut dirs = vec![dir.clone()];
    for extra in ["Scripts", "bin"] {
        let d = dir.join(extra);
        if d.is_dir() {
            dirs.push(d);
        }
    }
    dirs
}

#[cfg(windows)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

fn sh_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('"', "\\\""))
}

fn prepare_term_command(command: &str, py: Option<&str>, root: &Path) -> String {
    let t = command.trim();
    let low = t.to_ascii_lowercase();
    if let Some(py) = py {
        let is_pip = low == "pip" || low.starts_with("pip ") || low == "pip3" || low.starts_with("pip3 ");
        if is_pip {
            let rest = if low == "pip3" || low.starts_with("pip3 ") {
                t.get(4..).unwrap_or("")
            } else {
                t.get(3..).unwrap_or("")
            };
            #[cfg(windows)]
            {
                return format!("& {} -m pip{}", ps_quote(py), rest);
            }
            #[cfg(not(windows))]
            {
                return format!("{} -m pip{}", sh_quote(py), rest);
            }
        }
        let is_py = low == "python"
            || low.starts_with("python ")
            || low == "python3"
            || low.starts_with("python3 ");
        if is_py && !low.starts_with("python3.") {
            let rest = if low == "python3" || low.starts_with("python3 ") {
                t.get(7..).unwrap_or("")
            } else {
                t.get(6..).unwrap_or("")
            };
            #[cfg(windows)]
            {
                return format!("& {}{}", ps_quote(py), rest);
            }
            #[cfg(not(windows))]
            {
                return format!("{}{}", sh_quote(py), rest);
            }
        }
    }
    if low.starts_with("npm ")
        && !low.contains("--prefix")
        && !low.contains(" -g")
        && !low.contains(" --global")
    {
        let lib = root.join("libraries");
        let _ = fs::create_dir_all(&lib);
        let prefix = pretty_path(&lib);
        if let Some((_, rest)) = t.split_once(' ') {
            return format!("npm --prefix {} {}", sh_quote(&prefix), rest);
        }
    }
    t.to_string()
}

fn term_timeout_secs(command: &str) -> u64 {
    let l = command.to_ascii_lowercase();
    if l.contains("pip") || l.contains("npm") || l.contains("npx") || l.contains("cargo") {
        900
    } else if l.trim_start().starts_with("git") || l.contains(" git ") {
        300
    } else {
        180
    }
}

fn abs_dir(base: &Path, target: &str) -> PathBuf {
    let target = pretty_path_str(target.trim().trim_matches('"').trim_matches('\''));
    if target == "~" {
        return home_dir();
    }
    let p = PathBuf::from(&target);
    let joined = if p.is_absolute() { p } else { base.join(p) };
    match joined.canonicalize() {
        Ok(c) => PathBuf::from(pretty_path(&c)),
        Err(_) => joined,
    }
}

#[tauri::command]
fn term_cwd() -> TermCwd {
    TermCwd {
        cwd: pretty_path(&data_root()),
        shell: term_shell(),
    }
}

fn decode_out(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }
    let utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() > 8 && bytes.iter().filter(|b| **b == 0).count() > bytes.len() / 5);
    if utf16 {
        let skip = if bytes.starts_with(&[0xFF, 0xFE]) { 2 } else { 0 };
        let u16s: Vec<u16> = bytes[skip..]
            .chunks(2)
            .map(|c| u16::from_le_bytes([c[0], c.get(1).copied().unwrap_or(0)]))
            .collect();
        return String::from_utf16_lossy(&u16s);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

fn term_ok(dir: &Path, stdout: String, stderr: String, code: i32) -> TermResult {
    TermResult {
        cwd: pretty_path(dir),
        stdout,
        stderr,
        code,
        shell: term_shell(),
    }
}

#[tauri::command]
fn term_exec(command: String, cwd: String) -> Result<TermResult, String> {
    crate::app::policy::commands::entitlement_ok()?;
    let mut dir = resolve_cwd(&cwd);
    let command = command.trim().to_string();
    if command.is_empty() {
        return Ok(term_ok(&dir, String::new(), String::new(), 0));
    }
    if command == "pwd" {
        let s = pretty_path(&dir);
        return Ok(term_ok(&dir, s, String::new(), 0));
    }
    if command == "cd" || command == "cd ~" {
        dir = home_dir();
        return Ok(term_ok(&dir, String::new(), String::new(), 0));
    }
    if let Some(rest) = command.strip_prefix("cd ") {
        let target = rest.trim();
        let next = abs_dir(&dir, target);
        if next.is_dir() {
            dir = next;
            return Ok(term_ok(&dir, String::new(), String::new(), 0));
        }
        return Ok(term_ok(
            &dir,
            String::new(),
            format!("cd: not a directory: {target}"),
            1,
        ));
    }

    let resource_root = project_root();
    let root = data_root();
    let _ = fs::create_dir_all(root.join("libraries").join("python"));
    let py = engine_python();
    let command = prepare_term_command(&command, py.as_deref(), &root);
    let timeout_secs = term_timeout_secs(&command);

    #[cfg(windows)]
    let wrapped = format!(
        "$OutputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; {command}"
    );
    #[cfg(windows)]
    let mut cmd = {
        let mut c = Command::new("powershell");
        c.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            &wrapped,
        ]);
        c
    };
    #[cfg(not(windows))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-lc", &command]);
        c
    };

    cmd.current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.env("DATAREFINE_ROOT", &resource_root);
    cmd.env("DATAREFINE_DATA", &root);
    cmd.env("PYTHONUTF8", "1");
    if let Some(ref exe) = py {
        cmd.env("DATAREFINE_PYTHON", exe);
        let mut path_prefix = String::new();
        for d in python_path_dirs(exe) {
            path_prefix.push_str(&pretty_path(&d));
            #[cfg(windows)]
            path_prefix.push(';');
            #[cfg(not(windows))]
            path_prefix.push(':');
        }
        if !path_prefix.is_empty() {
            let key = if cfg!(windows) { "Path" } else { "PATH" };
            let old = std::env::var_os(key).or_else(|| std::env::var_os("PATH"));
            let mut combined = path_prefix;
            if let Some(o) = old {
                combined.push_str(&o.to_string_lossy());
            }
            cmd.env(key, combined);
        }
    }
    apply_no_window(&mut cmd);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start shell: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let t_out = thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(mut o) = stdout {
            let _ = o.read_to_end(&mut s);
        }
        decode_out(&s)
    });
    let t_err = thread::spawn(move || {
        let mut s = Vec::new();
        if let Some(mut e) = stderr {
            let _ = e.read_to_end(&mut s);
        }
        decode_out(&s)
    });

    let start = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(timeout_secs) {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Ok(term_ok(
                        &dir,
                        t_out.join().unwrap_or_default(),
                        {
                            let mut e = t_err.join().unwrap_or_default();
                            if !e.is_empty() {
                                e.push('\n');
                            }
                            e.push_str(&format!("Command timed out after {timeout_secs}s."));
                            e
                        },
                        124,
                    ));
                }
                thread::sleep(Duration::from_millis(40));
            }
            Err(e) => return Err(e.to_string()),
        }
    };

    Ok(term_ok(
        &dir,
        t_out.join().unwrap_or_default(),
        t_err.join().unwrap_or_default(),
        status.code().unwrap_or(if status.success() { 0 } else { 1 }),
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let license_state = crate::app::policy::LicenseState::new(data_root().join("config"));
    #[cfg(feature = "tauri-cmds")]
    crate::app::policy::commands::set_global(license_state.clone());
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Sidecar::new())
        .manage(license_state)
        .invoke_handler(tauri::generate_handler![
            sidecar_status,
            sidecar_restart,
            win_minimize,
            win_toggle_maximize,
            win_close,
            save_download_file,
            open_path,
            term_cwd,
            term_exec,
            crate::app::policy::commands::license_bootstrap,
            crate::app::policy::commands::license_state,
            crate::app::policy::commands::license_activate,
            crate::app::policy::commands::license_continue_basic,
            crate::app::policy::commands::license_require_feature,
            crate::app::policy::commands::license_check_now,
            crate::app::policy::commands::license_remove,
            crate::app::policy::commands::license_resume,
            crate::app::policy::commands::license_dismiss,
            crate::app::policy::commands::license_machine_id,
            crate::app::policy::commands::license_app_info,
            crate::app::policy::commands::license_open_url,
            ai::commands::ai_router,
            ai::commands::ai_credits,
            ai::commands::ai_credit_purchase,
            ai::commands::ai_usage_check,
            ai::commands::ai_usage_record,
            ai::commands::ai_jobs_submit,
            ai::commands::ai_jobs_get,
            ai::commands::ai_jobs_cancel,
            plugins::commands::plugin_list,
            plugins::commands::plugin_ai_check,
            ai::commands::ai_byok_save,
            ai::commands::ai_byok_delete,
            ai::commands::ai_byok_status,
            ai::commands::ai_local_status,
            ai::commands::ai_endpoint,
            ai::commands::ai_estimate,
            ai::commands::ai_run,
            plugins::commands::plugin_sync,
            plugins::commands::plugin_marketplace_search,
            plugins::commands::plugin_install,
            plugins::commands::plugin_uninstall,
            plugins::commands::plugin_set_enabled,
            crate::app::policy::commands::license_announcements,
            crate::app::policy::commands::check_for_update,
            crate::app::policy::commands::cloud_diagnostics,
            crate::app::policy::commands::update_download
        ])
        .setup(|app| {
            let main = build_main_window(app.handle())?;
            append_log("desktop startup main window created label=main");
            eprintln!("[DataRefine Studio][startup] main window created: {}", main.label());
            crate::app::policy::commands::set_app_handle(app.handle().clone());
            let handle = app.handle().clone();
            let _ = std::thread::Builder::new()
                .name("drs-sidecar".into())
                .spawn(move || {
                    let state = handle.state::<Sidecar>();
                    match start_into(&state) {
                        Ok(()) => {
                            if wait_until_up(&state, 90000) {
                                eprintln!("[DataRefine Studio] engine on :{}", state.port.lock().map(|g| *g).unwrap_or(17831));
                            } else {
                                eprintln!(
                                    "[DataRefine Studio] engine did not bind. {}",
                                    state.last_error.lock().map(|g| g.clone()).unwrap_or_default()
                                );
                            }
                        }
                        Err(err) => eprintln!("[DataRefine Studio] {err}"),
                    }
                    loop {
                        std::thread::sleep(Duration::from_millis(1500));
                        let port = state.port.lock().map(|g| *g).unwrap_or(17831);
                        if port_open(port) {
                            continue;
                        }
                        let ours = state.spawned_here.lock().map(|g| *g).unwrap_or(false);
                        if !ours {
                            continue;
                        }
                        let dead = {
                            if let Ok(mut g) = state.child.lock() {
                                match g.as_mut() {
                                    Some(child) => matches!(child.try_wait(), Ok(Some(_))),
                                    None => true,
                                }
                            } else {
                                false
                            }
                        };
                        if dead {
                            append_log("engine died — restarting once");
                            kill_child(&state);
                            let _ = start_into(&state);
                        }
                    }
                });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while running DataRefine Studio")
        .run(|app_handle, event| {
            if let RunEvent::WindowEvent { label, event: win, .. } = &event {
                if matches!(win, tauri::WindowEvent::Destroyed) {
                    append_log(&format!("desktop window destroyed label={label}"));
                    eprintln!("[DataRefine Studio][window-destroyed] {label}");
                }
                if matches!(win, tauri::WindowEvent::Focused(true)) {
                    if let Some(st) = app_handle.try_state::<Arc<crate::app::policy::LicenseState>>() {
                        crate::app::policy::scheduler::resume_check(st.inner().clone());
                    }
                }
            }
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                if let Some(state) = app_handle.try_state::<Sidecar>() {
                    let ours = state.spawned_here.lock().map(|g| *g).unwrap_or(false);
                    if ours {
                        kill_child(&state);
                    }
                }
            }
        });
}
