/**
 * Incremental parser for text/event-stream (WHATWG HTML "server-sent events",
 * section 9.2.6), fed with decoded text chunks of any size.
 *
 * - lines end in CRLF, LF or CR; a CR at the very end of a chunk is held back in
 *   case the next chunk starts with LF
 * - a blank line dispatches the pending event; "event:" sets its type (default
 *   "message"), "data:" lines are joined with "\n", one leading space after the
 *   colon is dropped, "id:"/"retry:"/unknown fields are ignored
 * - lines starting with ":" are comments (the proxy's ": ping" keepalives)
 * - an event with no data lines is not dispatched
 * - a leading byte order mark is ignored
 *
 * One deliberate leniency: end() dispatches a final event that has data but no
 * terminating blank line (the spec drops it). Every payload is validated by the
 * caller anyway, and losing a final "done" to a missing newline is worse.
 */

export interface SseEvent {
  event: string;
  data: string;
}

export class SseParser {
  private buffer = '';
  private eventType = '';
  private dataLines: string[] = [];
  private hasData = false;
  private started = false;
  /** Comment lines seen so far (keepalive pings), for diagnostics and tests. */
  comments = 0;

  push(chunk: string): SseEvent[] {
    if (!chunk) return [];
    let text = chunk;
    if (!this.started) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.buffer += text;
    return this.drain(false);
  }

  /** Call once the stream has ended. */
  end(): SseEvent[] {
    const events = this.drain(true);
    if (this.buffer.length > 0) {
      this.processLine(this.buffer, events);
      this.buffer = '';
    }
    if (this.hasData) events.push(this.take());
    return events;
  }

  private drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    let start = 0;
    const buf = this.buffer;
    for (let i = 0; i < buf.length; i++) {
      const ch = buf.charCodeAt(i);
      if (ch !== 10 && ch !== 13) continue;
      if (ch === 13) {
        if (i === buf.length - 1 && !final) break; // wait: maybe CRLF split across chunks
        this.processLine(buf.slice(start, i), events);
        if (buf.charCodeAt(i + 1) === 10) i++;
      } else {
        this.processLine(buf.slice(start, i), events);
      }
      start = i + 1;
    }
    this.buffer = buf.slice(start);
    return events;
  }

  private processLine(line: string, events: SseEvent[]): void {
    if (line === '') {
      if (this.hasData) events.push(this.take());
      else this.eventType = '';
      return;
    }
    if (line.charCodeAt(0) === 58 /* ":" */) {
      this.comments++;
      return;
    }
    const colon = line.indexOf(':');
    let field: string;
    let value: string;
    if (colon === -1) {
      field = line;
      value = '';
    } else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.charCodeAt(0) === 32) value = value.slice(1);
    }
    if (field === 'event') {
      this.eventType = value;
    } else if (field === 'data') {
      this.dataLines.push(value);
      this.hasData = true;
    }
    // "id", "retry" and unknown fields are ignored: the widget never reconnects.
  }

  private take(): SseEvent {
    const event: SseEvent = { event: this.eventType || 'message', data: this.dataLines.join('\n') };
    this.eventType = '';
    this.dataLines = [];
    this.hasData = false;
    return event;
  }
}
