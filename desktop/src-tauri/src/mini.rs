//! Janela flutuante (picture-in-picture) do app desktop.
//!
//! O WebView2 não abre o picture-in-picture do navegador, então o próprio app vira
//! a janela flutuante: fica pequeno, sem borda, sempre por cima e no canto da tela.
//! A página mostra só a live escolhida. A conexão com a sala continua a mesma.

use std::sync::Mutex;

use tauri::{LogicalSize, PhysicalPosition, PhysicalSize, Position, Size, State, WebviewWindow};

/// Tamanho/posição da janela antes de entrar no modo mini, para restaurar depois.
#[derive(Default)]
pub struct MiniState(Mutex<Option<Saved>>);

struct Saved {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    maximized: bool,
}

const MINI_W: f64 = 480.0;
const MINI_H: f64 = 270.0;
const MARGIN: f64 = 16.0;

#[tauri::command]
pub fn set_mini_mode(window: WebviewWindow, state: State<'_, MiniState>, on: bool) -> Result<(), String> {
    let mut saved = state.0.lock().map_err(|e| e.to_string())?;
    let err = |e: tauri::Error| e.to_string();

    if on {
        if saved.is_none() {
            *saved = Some(Saved {
                position: window.outer_position().map_err(err)?,
                size: window.inner_size().map_err(err)?,
                maximized: window.is_maximized().unwrap_or(false),
            });
        }
        if window.is_fullscreen().unwrap_or(false) {
            window.set_fullscreen(false).map_err(err)?;
        }
        window.unmaximize().map_err(err)?;
        window.set_decorations(false).map_err(err)?;
        window.set_min_size(Some(Size::Logical(LogicalSize::new(240.0, 135.0)))).map_err(err)?;
        window.set_size(Size::Logical(LogicalSize::new(MINI_W, MINI_H))).map_err(err)?;
        window.set_always_on_top(true).map_err(err)?;

        // Canto inferior direito da área útil do monitor (sem cobrir a barra de tarefas)
        if let Ok(Some(monitor)) = window.current_monitor() {
            let scale = monitor.scale_factor();
            let area = monitor.work_area();
            let w = (MINI_W * scale) as i32;
            let h = (MINI_H * scale) as i32;
            let m = (MARGIN * scale) as i32;
            let x = area.position.x + area.size.width as i32 - w - m;
            let y = area.position.y + area.size.height as i32 - h - m;
            window.set_position(Position::Physical(PhysicalPosition::new(x, y))).map_err(err)?;
        }
    } else {
        window.set_always_on_top(false).map_err(err)?;
        window.set_decorations(true).map_err(err)?;
        window.set_min_size(Some(Size::Logical(LogicalSize::new(800.0, 560.0)))).map_err(err)?;
        if let Some(prev) = saved.take() {
            window.set_size(Size::Physical(prev.size)).map_err(err)?;
            window.set_position(Position::Physical(prev.position)).map_err(err)?;
            if prev.maximized {
                window.maximize().map_err(err)?;
            }
        } else {
            window.set_size(Size::Logical(LogicalSize::new(1280.0, 800.0))).map_err(err)?;
            window.center().map_err(err)?;
        }
        window.set_focus().ok();
    }
    Ok(())
}
