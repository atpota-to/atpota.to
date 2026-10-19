/**
 * Server-Sent Events: an encoder for what the proxy sends the browser and an
 * incremental parser for what the bot sends the proxy (WHATWG event-stream rules:
 * LF, CRLF or CR line ends; "event", "data", "id" fields; ":" comments; a blank line
 * dispatches). The parser refuses unbounded input so a broken upstream cannot grow memory.
 */

export const PING = ': ping\n\n';

/** One event; JSON.stringify escapes CR/LF, so data is always a single line. */
export function encodeEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export interface SseEvent {
  event: string;
  data: string;
}

export class SseOverflowError extends Error {
  override name = 'SseOverflowError';
}

export class SseParser {
  private buffer = '';
  private event = '';
  private data: string[] = [];
  private dataSize = 0;
  private sawCr = false;
  /** Comment lines (": ping") seen so far. */
  comments = 0;

  constructor(private readonly maxEventBytes = 256 * 1024) {}

  push(chunk: string): SseEvent[] {
    const out: SseEvent[] = [];
    let text = chunk;
    // A CRLF split across chunks: drop the LF that completes a CR already handled.
    if (this.sawCr && text.startsWith('\n')) text = text.slice(1);
    this.sawCr = false;
    this.buffer += text;

    let start = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      const line = this.buffer.slice(start, i);
      if (ch === 13) {
        if (i + 1 < this.buffer.length) {
          if (this.buffer.charCodeAt(i + 1) === 10) i++;
        } else {
          this.sawCr = true;
        }
      }
      start = i + 1;
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    this.buffer = this.buffer.slice(start);
    if (this.buffer.length + this.dataSize > this.maxEventBytes) {
      throw new SseOverflowError('event too large');
    }
    return out;
  }

  /** Flush at end of stream. A trailing event without its blank line is discarded, per spec. */
  end(): SseEvent[] {
    this.buffer = '';
    this.event = '';
    this.data = [];
    this.dataSize = 0;
    return [];
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return null;
      }
      const ev = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      this.dataSize = 0;
      return ev;
    }
    if (line.startsWith(':')) {
      this.comments++;
      return null;
    }
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') {
      this.data.push(value);
      this.dataSize += value.length + 1;
      if (this.dataSize > this.maxEventBytes) throw new SseOverflowError('event too large');
    }
    // "id" and "retry" are irrelevant to a one-shot relay; anything else is ignored per spec.
    return null;
  }
}
