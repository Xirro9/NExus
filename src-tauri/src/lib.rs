mod api;
mod service;
mod sse_pump;
mod telemetry;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let client = reqwest::Client::new();
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
        .manage(client.clone())
        .manage(telemetry::TelemetryState::spawn(client))
        .invoke_handler(tauri::generate_handler![
            api::api_fetch,
            sse_pump::event_stream_start,
            sse_pump::event_stream_stop,
            telemetry::telemetry_snapshot
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
