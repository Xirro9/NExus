pub mod api;
pub mod service;
pub mod sse_pump;
pub mod telemetry;

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

/// Show + focus the main window (single-instance callback, tray Show,
/// left-click). Telemetry + SSE keep running while hidden — close-to-tray
/// keeps the always-on monitor alive (SPEC-PHASE4 §7).
fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::new();
    tauri::Builder::default()
        // single instance FIRST (spec §3 lib.rs target shape): a second
        // launch focuses the existing window instead of spawning a process
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // tray: Show / Hide / ─ / Quit
            let show = MenuItem::with_id(app, "show", "Show Jerry", true, None::<&str>)?;
            let hide = MenuItem::with_id(app, "hide", "Hide Jerry", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&show, &hide, &separator, &quit])?;
            TrayIconBuilder::with_id("jerry-tray")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or("default window icon missing")?,
                )
                .tooltip("Jerry")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => show_main(app),
                    "hide" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .manage(client.clone())
        .manage(telemetry::TelemetryState::spawn(client))
        .invoke_handler(tauri::generate_handler![
            api::api_fetch,
            sse_pump::event_stream_start,
            sse_pump::event_stream_stop,
            telemetry::telemetry_snapshot
        ])
        .on_window_event(|window, event| {
            // close-to-tray: X hides the window; Quit lives in the tray
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
