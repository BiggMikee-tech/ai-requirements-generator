// Netlify Function: proxies prompts to the Anthropic Messages API and streams
// the model's response back to the browser as plain text.
//
// Streaming keeps time-to-first-byte low and lets the page render output as it
// arrives, so a long Sonnet generation no longer has to complete inside a
// single synchronous response before the browser sees anything.

const json = (obj, status) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });

export default async (req) => {
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  let prompt;
  try {
    ({ prompt } = await req.json());
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!prompt || typeof prompt !== 'string') {
    return json({ error: 'Missing prompt' }, 400);
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return json({ error: 'Server misconfigured: missing ANTHROPIC_API_KEY' }, 500);
  }

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        stream: true,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  } catch {
    return json({ error: 'Failed to reach Anthropic API' }, 502);
  }

  // Anthropic reports errors (bad key, overloaded, rate limit, etc.) before the
  // stream begins, as a normal JSON body. Surface those as JSON so the browser
  // can show a clean message instead of an empty stream.
  if (!upstream.ok || !upstream.body) {
    let message = 'Anthropic API error';
    try {
      const err = await upstream.json();
      message = err.error?.message || message;
    } catch {}
    return json({ error: message }, upstream.ok ? 502 : upstream.status);
  }

  // Transform Anthropic's Server-Sent Events into a bare stream of text deltas,
  // so the client only has to concatenate the chunks it receives.
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const toPlainText = new TransformStream({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload) continue;
        try {
          const event = JSON.parse(payload);
          if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            controller.enqueue(encoder.encode(event.delta.text));
          }
        } catch {
          // Ignore keep-alive pings and any partial JSON lines.
        }
      }
    }
  });

  return new Response(upstream.body.pipeThrough(toPlainText), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no'
    }
  });
};

export const config = {
  path: '/api/generate',
  timeout: 26
};
