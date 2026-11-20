//! Faz o L — app desktop.
//!
//! A janela abre o site do servidor do Faz o L (o mesmo que roda no navegador).
//! Quando a página está dentro do app, o botão "Transmitir" chama os comandos
//! nativos daqui: captura de tela pela GPU, áudio do sistema sem o som do próprio
//! app e envio direto para o LiveKit.

mod headless;
mod server;
mod stream;

/// Modo de teste sem janela (`--test-stream`). Retorna o código de saída.
pub fn run_test_stream(args: &[String]) -> i32 {
    headless::run(args)
}

#[cfg(windows)]
mod audio;
#[cfg(windows)]
mod capture;

pub fn run() {
    tauri::Builder::default()
        .manage(stream::StreamState::default())
        .invoke_handler(tauri::generate_handler![
            server::get_server,
            server::set_server,
            stream::list_monitors,
            stream::start_stream,
            stream::stop_stream,
        ])
        .setup(|app| {
            server::open_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Faz o L");
}
