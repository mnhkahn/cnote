//! Theme identifiers shared by native hosts.
use serde::Serialize;
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
}
