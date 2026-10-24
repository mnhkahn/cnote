//! Extract a sidebar label without changing the note's cloud file name.
use html5ever::tokenizer::{
    BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, states::RawKind,
};
use std::cell::RefCell;

#[derive(Default)]
struct Heading {
    current: Option<String>,
    found: String,
    ignored: Vec<String>,
}
impl Heading {
    fn finish(&mut self) {
        if let Some(text) = self.current.take() {
            self.found = text.split_whitespace().collect::<Vec<_>>().join(" ");
        }
    }
}
struct HeadingSink(RefCell<Heading>);

impl TokenSink for HeadingSink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        use html5ever::tokenizer::TagKind::{EndTag, StartTag};
        let mut state = self.0.borrow_mut();
        if !state.found.is_empty() {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::TagToken(tag) => {
                let name = tag.name.as_ref();
                if tag.kind == EndTag && state.ignored.last().is_some_and(|last| last == name) {
                    state.ignored.pop();
                } else if tag.kind == StartTag
                    && matches!(
                        name,
                        "script" | "style" | "template" | "svg" | "math" | "iframe" | "object"
                    )
                {
                    state.ignored.push(name.to_owned());
                    if name == "script" {
                        return TokenSinkResult::RawData(RawKind::ScriptData);
                    }
                    if matches!(name, "style" | "iframe") {
                        return TokenSinkResult::RawData(RawKind::Rawtext);
                    }
                } else if state.ignored.is_empty() {
                    if matches!(name, "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
                        state.finish();
                        if tag.kind == StartTag && state.found.is_empty() {
                            state.current = Some(String::new());
                        }
                    } else if name == "br"
                        && let Some(text) = &mut state.current
                    {
                        text.push(' ');
                    }
                }
            }
            Token::CharacterTokens(text) if state.ignored.is_empty() => {
                if let Some(current) = &mut state.current {
                    current.push_str(&text);
                }
            }
            Token::EOFToken => state.finish(),
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

pub fn heading(html: &str) -> String {
    let input = BufferQueue::default();
    let tokenizer = Tokenizer::new(
        HeadingSink(RefCell::new(Heading::default())),
        Default::default(),
    );
    // Stop after the first heading instead of scanning large images or bodies.
    let mut remaining = html;
    while !remaining.is_empty() && tokenizer.sink.0.borrow().found.is_empty() {
        let mut end = remaining.len().min(4096);
        while !remaining.is_char_boundary(end) {
            end -= 1;
        }
        input.push_back(remaining[..end].into());
        let _ = tokenizer.feed(&input);
        remaining = &remaining[end..];
    }
    tokenizer.end();
    tokenizer.sink.0.into_inner().found
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn first_nonempty_heading_matches_body_text() {
        assert_eq!(
            heading("<h1> </h1><H2>AI<strong>各种</strong>琢磨 &amp; 笔记</H2><h1>后面的标题</h1>"),
            "AI各种琢磨 & 笔记"
        );
        assert_eq!(
            heading("<p>前言</p><h3> 第一行<br> 第二行&nbsp; &#x2713; </h3>"),
            "第一行 第二行 ✓"
        );
        assert_eq!(heading("<h2>没有闭合的标题"), "没有闭合的标题");
        assert_eq!(heading("<p>只有正文</p>"), "");
        assert_eq!(
            heading(&format!(
                "{}<h2>跨块的中文 &amp; 标题</h2>",
                " ".repeat(4090)
            )),
            "跨块的中文 & 标题"
        );
    }
    #[test]
    fn non_content_tags_do_not_supply_titles() {
        assert_eq!(
            heading(
                "<script>const x='<h1>伪标题</h1>';</script><template><h1>模板</h1></template><h2>正文标题</h2>"
            ),
            "正文标题"
        );
    }
}
