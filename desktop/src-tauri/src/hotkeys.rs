//! Atalhos globais de clipe (funcionam com o jogo em foco):
//! Ctrl+F9 = últimos 30 s, Ctrl+F10 = último 1 min, Ctrl+F11 = últimos 3 min.
//! O app só avisa a página (evento "clip-hotkey" com os segundos); quem gera o
//! clipe é o site, igual ao botão ✂ Clipar.

use tauri::{AppHandle, Emitter, Runtime};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const HOTKEYS: [(Code, u32, &str); 3] = [
    (Code::F9, 30, "Ctrl+F9"),
    (Code::F10, 60, "Ctrl+F10"),
    (Code::F11, 180, "Ctrl+F11"),
];

fn shortcut(code: Code) -> Shortcut {
    Shortcut::new(Some(Modifiers::CONTROL), code)
}

pub fn plugin<R: Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, pressed, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            if let Some((_, seconds, label)) = HOTKEYS.iter().find(|(code, ..)| shortcut(*code) == *pressed) {
                log::info!("atalho {label}: clipe de {seconds} s");
                let _ = app.emit("clip-hotkey", *seconds);
            }
        })
        .build()
}

/// Registra os atalhos. Se outro programa já usa algum, só avisa no log.
pub fn register<R: Runtime>(app: &AppHandle<R>) {
    for (code, _, label) in HOTKEYS {
        if let Err(err) = app.global_shortcut().register(shortcut(code)) {
            log::warn!("não consegui registrar o atalho {label}: {err}");
        }
    }
}
