mod api;
mod service;
mod sse_pump;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .manage(reqwest::Client::new())
        .invoke_handler(tauri::generate_handler![
            api::api_fetch,
            sse_pump::event_stream_start,
            sse_pump::event_stream_stop
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
