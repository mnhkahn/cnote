use gpui::WindowAppearance;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Theme {
    #[default]
    System,
    Light,
    Dark,
}
impl Theme {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "system" => Some(Self::System),
            "light" => Some(Self::Light),
            "dark" => Some(Self::Dark),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
    pub fn appearance(self) -> Option<WindowAppearance> {
        match self {
            Self::System => None,
            Self::Light => Some(WindowAppearance::Light),
            Self::Dark => Some(WindowAppearance::Dark),
        }
    }
    pub fn is_dark(self, appearance: WindowAppearance) -> bool {
        matches!(
            self.appearance().unwrap_or(appearance),
            WindowAppearance::Dark | WindowAppearance::VibrantDark
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn explicit_themes_override_system_and_system_removes_override() {
        assert!(!Theme::Light.is_dark(WindowAppearance::Dark));
        assert!(Theme::Dark.is_dark(WindowAppearance::Light));
        assert!(Theme::System.is_dark(WindowAppearance::Dark));
        assert!(!Theme::System.is_dark(WindowAppearance::Light));
        assert_eq!(Theme::System.appearance(), None);
        for theme in [Theme::System, Theme::Light, Theme::Dark] {
            assert_eq!(Theme::parse(theme.as_str()), Some(theme));
        }
        assert_eq!(Theme::parse("unknown"), None);
    }
}
