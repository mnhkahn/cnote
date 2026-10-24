use gpui::WindowAppearance;
use serde::{Deserialize, Serialize};
use std::sync::OnceLock;

pub const CATALOG: &str = include_str!("../editor/themes.json");

#[derive(Deserialize)]
pub struct Palette {
    pub id: String,
    pub label: String,
    pub dark: bool,
    pub bg: String,
    pub sidebar: String,
    pub ink: String,
    pub muted: String,
    pub line: String,
    pub active: String,
    pub accent: String,
}
impl Palette {
    pub fn rgb(&self, value: &str) -> u32 {
        u32::from_str_radix(value, 16).expect("valid theme color")
    }
}
fn palettes() -> &'static [Palette] {
    static PALETTES: OnceLock<Vec<Palette>> = OnceLock::new();
    PALETTES.get_or_init(|| serde_json::from_str(CATALOG).expect("valid theme catalog"))
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
    Sepia,
    Sakura,
    Mint,
    Lavender,
    Sand,
    Arctic,
    SolarizedLight,
    Ivory,
    Sky,
    Nord,
    Forest,
    Dracula,
    Monokai,
    Midnight,
    Ocean,
    Gruvbox,
    SolarizedDark,
    Charcoal,
}
impl Theme {
    pub const ALL: [Self; 21] = [
        Self::System,
        Self::Light,
        Self::Dark,
        Self::Sepia,
        Self::Sakura,
        Self::Mint,
        Self::Lavender,
        Self::Sand,
        Self::Arctic,
        Self::SolarizedLight,
        Self::Ivory,
        Self::Sky,
        Self::Nord,
        Self::Forest,
        Self::Dracula,
        Self::Monokai,
        Self::Midnight,
        Self::Ocean,
        Self::Gruvbox,
        Self::SolarizedDark,
        Self::Charcoal,
    ];
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|theme| theme.as_str() == value)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
            Self::Sepia => "sepia",
            Self::Sakura => "sakura",
            Self::Mint => "mint",
            Self::Lavender => "lavender",
            Self::Sand => "sand",
            Self::Arctic => "arctic",
            Self::SolarizedLight => "solarized_light",
            Self::Ivory => "ivory",
            Self::Sky => "sky",
            Self::Nord => "nord",
            Self::Forest => "forest",
            Self::Dracula => "dracula",
            Self::Monokai => "monokai",
            Self::Midnight => "midnight",
            Self::Ocean => "ocean",
            Self::Gruvbox => "gruvbox",
            Self::SolarizedDark => "solarized_dark",
            Self::Charcoal => "charcoal",
        }
    }
    pub fn label(self) -> &'static str {
        if self == Self::System {
            "跟随系统"
        } else {
            &self.palette(WindowAppearance::Light).label
        }
    }
    pub fn appearance(self) -> Option<WindowAppearance> {
        if self == Self::System {
            return None;
        }
        Some(if self.palette(WindowAppearance::Light).dark {
            WindowAppearance::Dark
        } else {
            WindowAppearance::Light
        })
    }
    pub fn palette(self, appearance: WindowAppearance) -> &'static Palette {
        let resolved = if self == Self::System {
            if matches!(
                appearance,
                WindowAppearance::Dark | WindowAppearance::VibrantDark
            ) {
                Self::Dark
            } else {
                Self::Light
            }
        } else {
            self
        };
        palettes()
            .iter()
            .find(|palette| palette.id == resolved.as_str())
            .expect("theme in catalog")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn themes_have_valid_palettes_and_round_trip() {
        assert_eq!(palettes().len(), Theme::ALL.len() - 1);
        for theme in Theme::ALL {
            assert_eq!(Theme::parse(theme.as_str()), Some(theme));
            assert_eq!(serde_json::to_value(theme).unwrap(), theme.as_str());
            let palette = theme.palette(WindowAppearance::Light);
            assert!(!theme.label().is_empty());
            for color in [
                &palette.bg,
                &palette.sidebar,
                &palette.ink,
                &palette.muted,
                &palette.line,
                &palette.active,
                &palette.accent,
            ] {
                assert_eq!(color.len(), 6);
                palette.rgb(color);
            }
            if theme != Theme::System {
                assert_eq!(theme.palette(WindowAppearance::Dark).id, palette.id);
                assert_eq!(
                    theme.appearance(),
                    Some(if palette.dark {
                        WindowAppearance::Dark
                    } else {
                        WindowAppearance::Light
                    })
                );
            }
        }
        assert_eq!(Theme::System.appearance(), None);
        assert_eq!(Theme::System.palette(WindowAppearance::Dark).id, "dark");
        assert_eq!(
            Theme::System.palette(WindowAppearance::VibrantDark).id,
            "dark"
        );
        assert_eq!(Theme::System.palette(WindowAppearance::Light).id, "light");
        assert_eq!(Theme::parse("unknown"), None);
    }
}
