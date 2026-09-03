// HTTP/1.1 message framing shared by the server parser and the client
// response reader: head boundaries, request-head parsing (body framing plus
// the keep-alive decision), and the chunked transfer-coding decoder.

const HTTP_MAX_CHUNK_LINE: usize = 8_192;

const HTTP_BAD_REQUEST_REPLY: &str =
    "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";

fn http_header_end(bytes: &[u8]) -> Option<usize> {
    bytes.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

fn http_token_present(value: &str, token: &str) -> bool {
    value.split(',').any(|part| part.trim().eq_ignore_ascii_case(token))
}

enum HttpBodyFraming {
    Length(usize),
    Chunked,
    Invalid,
}

struct HttpRequestHead {
    method: JsString,
    url: JsString,
    http10: bool,
    headers: Vec<(JsString, JsString, JsString)>,
    framing: HttpBodyFraming,
    keep_alive: bool,
}

fn http_parse_request_head(bytes: &[u8]) -> Option<HttpRequestHead> {
    let text = std::str::from_utf8(bytes).ok()?;
    let mut lines = text[..text.len().saturating_sub(4)].split("\r\n");
    let mut request_line = lines.next()?.split_whitespace();
    let method = string(request_line.next()?);
    let url = string(request_line.next()?);
    let version = request_line.next()?;
    if request_line.next().is_some() || !matches!(version, "HTTP/1.0" | "HTTP/1.1") {
        return None;
    }
    let mut headers = Vec::new();
    let mut content_length: Option<usize> = None;
    let mut transfer_encoding = false;
    let mut chunked = false;
    let mut keep_alive = version == "HTTP/1.1";
    for line in lines {
        let (raw_name, raw_value) = line.split_once(':')?;
        let name = raw_name.trim();
        let value = raw_value.trim();
        if name.is_empty() {
            return None;
        }
        let lower = name.to_ascii_lowercase();
        match lower.as_str() {
            "content-length" => content_length = Some(value.parse().ok()?),
            "transfer-encoding" => {
                transfer_encoding = true;
                chunked = http_token_present(value, "chunked");
            }
            "connection" => {
                if http_token_present(value, "close") {
                    keep_alive = false;
                } else if http_token_present(value, "keep-alive") {
                    keep_alive = true;
                }
            }
            _ => {}
        }
        headers.push((string(name), string(&lower), string(value)));
    }
    // A chunked transfer-coding wins over Content-Length, and the two
    // together (or an unsupported coding) are a framing error the caller
    // answers with 400.
    let framing = if transfer_encoding {
        if chunked && content_length.is_none() {
            HttpBodyFraming::Chunked
        } else {
            HttpBodyFraming::Invalid
        }
    } else {
        HttpBodyFraming::Length(content_length.unwrap_or(0))
    };
    Some(HttpRequestHead {
        method,
        url,
        http10: version == "HTTP/1.0",
        headers,
        framing,
        keep_alive,
    })
}

fn http_chunk(bytes: &[u8]) -> Vec<u8> {
    if bytes.is_empty() {
        return Vec::new();
    }
    let mut chunk = format!("{:x}\r\n", bytes.len()).into_bytes();
    chunk.extend_from_slice(bytes);
    chunk.extend_from_slice(b"\r\n");
    chunk
}

enum HttpChunkStep {
    NeedMore,
    Data(Vec<u8>),
    Done,
    Bad,
}

/// Advances the chunked decoder over `buffer` by one chunk. `chunk_remaining`
/// carries the size of a chunk whose size line was already consumed, so a
/// chunk split across feeds resumes where it stopped. `limit` caps how long a
/// size line may grow before the stream is rejected.
fn http_chunked_step(
    buffer: &mut Vec<u8>,
    chunk_remaining: &mut Option<usize>,
    limit: usize,
) -> HttpChunkStep {
    loop {
        if let Some(size) = *chunk_remaining {
            if buffer.len() < size + 2 {
                return HttpChunkStep::NeedMore;
            }
            let body = buffer.drain(..size).collect();
            buffer.drain(..2);
            *chunk_remaining = None;
            return HttpChunkStep::Data(body);
        }
        let Some(line_end) = buffer.windows(2).position(|window| window == b"\r\n") else {
            return if buffer.len() > limit {
                HttpChunkStep::Bad
            } else {
                HttpChunkStep::NeedMore
            };
        };
        let Ok(line) = std::str::from_utf8(&buffer[..line_end]) else {
            return HttpChunkStep::Bad;
        };
        // Chunk extensions after ';' are tolerated and ignored.
        let Ok(size) = usize::from_str_radix(line.split(';').next().unwrap_or("").trim(), 16) else {
            return HttpChunkStep::Bad;
        };
        buffer.drain(..line_end + 2);
        if size == 0 {
            if buffer.len() >= 2 {
                buffer.drain(..2);
            }
            return HttpChunkStep::Done;
        }
        *chunk_remaining = Some(size);
    }
}
