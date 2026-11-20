// Sem janela de console no Windows em release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--test-stream") {
        std::process::exit(faz_o_l_desktop::run_test_stream(&args));
    }
    faz_o_l_desktop::run();
}
