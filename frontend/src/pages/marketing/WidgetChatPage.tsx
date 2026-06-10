import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { API_URL } from '../../lib/env';

interface WidgetMessage {
  id: string;
  direction: 'INBOUND' | 'OUTBOUND';
  authorType?: string;
  body: string;
}

/**
 * Public web-chat surface (rendered at /widget?key=<widgetKey>, embedded in an
 * iframe by widget.js). No auth — bound by the unguessable widgetKey + a
 * visitorId persisted in localStorage. Talks to the public webchat API and
 * streams the thread over SSE. Intentionally self-contained (plain fetch, no
 * marketingApi) so it carries no operator credentials.
 */
export default function WidgetChatPage() {
  const [params] = useSearchParams();
  const widgetKey = params.get('key') ?? '';
  const base = `${API_URL}/public/webchat/${encodeURIComponent(widgetKey)}`;
  const lsKey = `wc:${widgetKey}`;

  const [visitorId, setVisitorId] = useState<string>('');
  const [conversationId, setConversationId] = useState<string>('');
  const [channelName, setChannelName] = useState<string>('Chat');
  const [greeting, setGreeting] = useState<string | null>(null);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);

  // Session bootstrap.
  useEffect(() => {
    if (!widgetKey) return;
    const saved = JSON.parse(localStorage.getItem(lsKey) || '{}');
    fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: saved.visitorId }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('session'))))
      .then((data) => {
        setVisitorId(data.visitorId);
        setChannelName(data.channel?.name ?? 'Chat');
        setGreeting(data.channel?.greeting ?? null);
        if (saved.conversationId) setConversationId(saved.conversationId);
        localStorage.setItem(lsKey, JSON.stringify({ ...saved, visitorId: data.visitorId }));
        setReady(true);
      })
      .catch(() => setReady(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [widgetKey]);

  // Load history + open the live stream once we have a conversation.
  useEffect(() => {
    if (!conversationId || !visitorId) return;
    const qs = `conversationId=${conversationId}&visitorId=${encodeURIComponent(visitorId)}`;
    fetch(`${base}/history?${qs}`)
      .then((r) => (r.ok ? r.json() : { messages: [] }))
      .then((data) => setMessages(data.messages ?? []));

    const es = new EventSource(`${base}/stream?${qs}`);
    es.onmessage = (evt) => {
      try {
        const data = JSON.parse(evt.data);
        if (data?.kind === 'message' && data.payload) {
          const m = data.payload;
          setMessages((prev) =>
            prev.some((x) => x.id === m.id)
              ? prev
              : [...prev, { id: m.id, direction: m.direction, authorType: m.authorType, body: m.body }],
          );
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, visitorId]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !visitorId) return;
    setDraft('');
    // Optimistic echo.
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, direction: 'INBOUND', body: text }]);
    const res = await fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, text }),
    }).then((r) => (r.ok ? r.json() : null));
    if (res?.conversationId && res.conversationId !== conversationId) {
      setConversationId(res.conversationId);
      const saved = JSON.parse(localStorage.getItem(lsKey) || '{}');
      localStorage.setItem(lsKey, JSON.stringify({ ...saved, conversationId: res.conversationId }));
    }
  }, [draft, visitorId, conversationId, base, lsKey]);

  if (!widgetKey) {
    return <div className="p-4 text-sm text-slate-500">Missing widget key.</div>;
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      <div className="px-4 py-3 bg-primary text-primary-foreground font-medium">{channelName}</div>
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-slate-50">
        {greeting && messages.length === 0 && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-3 py-2 text-sm bg-white border border-slate-200 text-slate-800">
              {greeting}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`flex ${m.direction === 'INBOUND' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words ${
                m.direction === 'INBOUND'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-white border border-slate-200 text-slate-800'
              }`}
            >
              {m.body}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="p-3 border-t border-slate-200 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && send()}
          disabled={!ready}
          placeholder={ready ? 'Type a message…' : 'Connecting…'}
          className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-primary outline-none"
        />
        <button
          onClick={send}
          disabled={!ready || !draft.trim()}
          className="px-4 py-2 bg-primary text-primary-foreground rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          Send
        </button>
      </div>
    </div>
  );
}
