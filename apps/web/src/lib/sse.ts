/**
 * Server-Sent Events over fetch, so the staff bearer token can be sent as a
 * header (EventSource cannot). Reconnects with backoff when the stream drops,
 * which happens on Wi-Fi blips and load-shedding.
 */
export interface SseEvent {
  event: string;
  data: string;
}

/** Split a buffer into complete events plus the unfinished remainder. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalised = buffer.replace(/\r\n/g, '\n');
  const blocks = normalised.split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // comment / heartbeat
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      if (field === 'data') data.push(value);
    }
    if (data.length) events.push({ event, data: data.join('\n') });
  }
  return { events, rest };
}

export function openStream(
  url: string,
  token: string,
  onEvent: (e: SseEvent) => void,
  onStatus: (live: boolean) => void,
): () => void {
  const controller = new AbortController();
  let delay = 1000;

  const run = async () => {
    while (!controller.signal.aborted) {
      try {
        const res = await fetch(url, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
        if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
        onStatus(true);
        delay = 1000;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const parsed = parseSse(buffer);
          buffer = parsed.rest;
          parsed.events.forEach(onEvent);
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      onStatus(false);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 15_000);
    }
  };
  void run();
  return () => controller.abort();
}
