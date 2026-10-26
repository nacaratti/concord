//! Casca nativa do Concord. A janela abre o Concord hospedado (como o app do Discord, que é o site
//! dentro de uma casca), e o lado nativo cuida do que o navegador não faz: ícone na bandeja,
//! notificações do sistema e uma tecla de push-to-talk que funciona com o jogo em foco.
//!
//! Configuração (variável de ambiente ou `config.json` na pasta de configuração do app):
//! - `CONCORD_URL` / `"url"`: endereço do Concord (padrão http://localhost:5173 em desenvolvimento)
//! - `CONCORD_PTT_KEY` / `"ptt_key"`: tecla do push-to-talk (padrão F8)

use serde::Deserialize;
use tauri::{
    ipc::CapabilityBuilder,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::NewWindowResponse,
    AppHandle, Emitter, Manager, Url, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

const DEFAULT_URL: &str = "http://localhost:5173";
const DEFAULT_PTT_KEY: &str = "F8";

#[derive(Deserialize, Default)]
struct Config {
    url: Option<String>,
    ptt_key: Option<String>,
}

fn load_config(app: &AppHandle) -> Config {
    let mut cfg: Config = app
        .path()
        .app_config_dir()
        .ok()
        .and_then(|dir| std::fs::read_to_string(dir.join("config.json")).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    if let Ok(url) = std::env::var("CONCORD_URL") {
        cfg.url = Some(url);
    }
    if let Ok(key) = std::env::var("CONCORD_PTT_KEY") {
        cfg.ptt_key = Some(key);
    }
    cfg
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // Abrir o app de novo só traz a janela existente para a frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        // Troca o window.Notification da página pelas notificações do sistema.
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            let handle = app.handle().clone();
            let cfg = load_config(&handle);
            let url: Url = cfg.url.as_deref().unwrap_or(DEFAULT_URL).parse()?;
            let origin = url.origin().ascii_serialization();
            let ptt_key = cfg.ptt_key.unwrap_or_else(|| DEFAULT_PTT_KEY.into());

            // A página remota só ganha acesso a eventos e notificações, e só na origem configurada.
            app.add_capability(
                CapabilityBuilder::new("concord-remote")
                    .remote(format!("{origin}/*"))
                    .window("main")
                    .permission("core:event:default")
                    .permission("notification:default"),
            )?;

            // Avisa a página de que está no app desktop e qual é a tecla do push-to-talk.
            let init = format!(
                "window.__CONCORD_DESKTOP__ = {{ pttKey: {} }};",
                serde_json::to_string(&ptt_key)?
            );
            let nav_origin = origin.clone();
            let nav_handle = handle.clone();
            let popup_handle = handle.clone();
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Concord")
                .inner_size(1280.0, 800.0)
                .min_inner_size(800.0, 500.0)
                .initialization_script(init)
                // Links para fora do Concord (anexos, sites) abrem no navegador do sistema, não no app.
                .on_navigation(move |target| {
                    if target.origin().ascii_serialization() == nav_origin {
                        return true;
                    }
                    let _ = nav_handle.opener().open_url(target.as_str(), None::<&str>);
                    false
                })
                .on_new_window(move |target, _features| {
                    let _ = popup_handle.opener().open_url(target.as_str(), None::<&str>);
                    NewWindowResponse::Deny
                })
                .build()?;

            // Fechar a janela só esconde: o Concord continua na bandeja, na call e recebendo menções.
            let hidden = window.clone();
            window.on_window_event(move |event| {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    let _ = hidden.hide();
                }
            });

            let show = MenuItem::with_id(app, "show", "Abrir o Concord", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Sair do Concord", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("ícone do app ausente")?)
                .tooltip("Concord")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
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

            // Push-to-talk global: o sistema avisa quando a tecla desce e sobe, mesmo com o jogo em foco,
            // e a página liga o microfone só enquanto ela está apertada.
            match ptt_key.parse::<Shortcut>() {
                Ok(shortcut) => {
                    let registered = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
                        let _ = app.emit("ptt", event.state() == ShortcutState::Pressed);
                    });
                    if let Err(err) = registered {
                        eprintln!("push-to-talk: não deu para registrar {ptt_key}: {err}");
                    }
                }
                Err(err) => eprintln!("push-to-talk: tecla inválida {ptt_key:?}: {err}"),
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("erro ao iniciar o Concord");
}
