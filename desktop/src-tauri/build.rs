fn main() {
    // Declara os comandos do app para gerar as permissões allow-<comando>,
    // usadas pela capability da página remota (o site do Faz o L).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "get_server",
            "set_server",
            "list_monitors",
            "gpu_encoder",
            "start_stream",
            "stop_stream",
        ]),
    ))
    .expect("falha ao rodar tauri-build");
}
