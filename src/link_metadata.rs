//! Fetch pasted link titles outside the WebView, without a third-party proxy.
use anyhow::{Result, ensure};
use html5ever::tokenizer::{
    BufferQueue, Token, TokenSink, TokenSinkResult, Tokenizer, states::RawKind,
};
use std::{cell::RefCell, io::Read, time::Duration};

const MAX_HTML: u64 = 1024 * 1024;

pub fn fetch_title(address: &str) -> Result<String> {
    let url = url::Url::parse(address)?;
    ensure!(matches!(url.scheme(), "http" | "https"));
    ensure!(url.username().is_empty() && url.password().is_none());
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::limited(5))
        .user_agent(concat!("CNote/", env!("CNOTE_APP_VERSION")))
        .build()?;
    let response = client.get(url).send()?.error_for_status()?;
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    ensure!(mime.starts_with("text/html") || mime.starts_with("application/xhtml+xml"));
    let mut bytes = Vec::new();
    response.take(MAX_HTML).read_to_end(&mut bytes)?;
    // A missing title or unsupported encoding leaves the original URL intact.
    let html = std::str::from_utf8(&bytes)?;
    Ok(title(html))
}

#[derive(Default)]
struct Title {
    inside: bool,
    done: bool,
    text: String,
}
struct Sink(RefCell<Title>);
impl TokenSink for Sink {
    type Handle = ();
    fn process_token(&self, token: Token, _: u64) -> TokenSinkResult<()> {
        use html5ever::tokenizer::TagKind::{EndTag, StartTag};
        let mut state = self.0.borrow_mut();
        if state.done {
            return TokenSinkResult::Continue;
        }
        match token {
            Token::TagToken(tag) if tag.name.as_ref() == "title" => {
                if tag.kind == StartTag {
                    state.inside = true;
                    return TokenSinkResult::RawData(RawKind::Rcdata);
                } else if tag.kind == EndTag {
                    state.inside = false;
                    state.done = true;
                }
            }
            Token::TagToken(tag)
                if tag.kind == StartTag && matches!(tag.name.as_ref(), "script" | "style") =>
            {
                return TokenSinkResult::RawData(if tag.name.as_ref() == "script" {
                    RawKind::ScriptData
                } else {
                    RawKind::Rawtext
                });
            }
            Token::CharacterTokens(text) if state.inside => state.text.push_str(&text),
            _ => {}
        }
        TokenSinkResult::Continue
    }
}

fn title(html: &str) -> String {
    let input = BufferQueue::default();
    let parser = Tokenizer::new(Sink(RefCell::new(Title::default())), Default::default());
    input.push_back(html.into());
    let _ = parser.feed(&input);
    parser.end();
    parser
        .sink
        .0
        .into_inner()
        .text
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_real_title_as_text() {
        assert_eq!(
            title(
                "<script>const x='<title>fake</title>'</script><TITLE> 中文 &amp;\n 笔记 &lt;b&gt; </TITLE><title>second</title>"
            ),
            "中文 & 笔记 <b>"
        );
        assert_eq!(title("<html><p>No title</p>"), "");
        assert_eq!(title("<title>Unclosed"), "Unclosed");
    }
    #[test]
    fn fetches_without_credentials_or_a_proxy() {
        use std::{io::Write, net::TcpListener};
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = format!("http://{}/page", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut request = [0; 4096];
            let count = stream.read(&mut request).unwrap();
            assert!(
                !String::from_utf8_lossy(&request[..count])
                    .to_lowercase()
                    .contains("authorization:")
            );
            let body = "<title>Example &amp; test</title>";
            write!(stream, "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
        });
        assert_eq!(fetch_title(&address).unwrap(), "Example & test");
        server.join().unwrap();
        assert!(fetch_title("file:///tmp/note").is_err());
        assert!(fetch_title("https://user:password@example.com").is_err());
    }
}
