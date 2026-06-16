import { useState, useEffect, useRef, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Send } from 'lucide-react';
import { API_URL } from '../../lib/env';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Spinner';
import { Avatar } from '@/components/ui/Avatar';

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
  const [accent, setAccent] = useState<string>('#1e40af');
  const [logo, setLogo] = useState<string | null>(null);
  const [messages, setMessages] = useState<WidgetMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [ready, setReady] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

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
        if (data.branding?.accentColor) setAccent(data.branding.accentColor);
        setLogo(data.branding?.logoUrl ?? null);
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
    inputRef.current?.focus();
  }, [draft, visitorId, conversationId, base, lsKey]);

  if (!widgetKey) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <p className="text-sm text-muted-foreground">Missing widget key.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-background">
      {/* Header — accent colour from branding, falls back to indigo */}
      <header
        className="shrink-0 flex items-center gap-2.5 px-4 py-3 text-white font-medium shadow-sm"
        style={{ background: accent }}
      >
        {logo ? (
          <img src={logo} alt="" className="h-6 w-auto object-contain" />
        ) : (
          <Avatar
            initials={channelName.slice(0, 2).toUpperCase()}
            size="sm"
            className="bg-white/20 text-white text-xs"
          />
        )}
        <span className="truncate text-sm font-semibold">{channelName}</span>

        {!ready && (
          <span className="ms-auto flex items-center gap-1.5 text-xs font-normal opacity-80">
            <Spinner className="h-3.5 w-3.5" />
            Connecting…
          </span>
        )}
      </header>

      {/* Message list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 bg-surface-muted">
        {greeting && messages.length === 0 && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-2xl px-3 py-2 text-sm bg-surface border border-border text-foreground shadow-xs">
              {greeting}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.direction === 'INBOUND' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[80%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap break-words shadow-xs ${
                m.direction === 'INBOUND'
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-surface border border-border text-foreground'
              }`}
            >
              {m.body}
            </div>
          </div>
        ))}

        <div ref={endRef} />
      </div>

      {/* Composer */}
      <div className="shrink-0 p-3 border-t border-border bg-surface flex items-center gap-2">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send()}
          disabled={!ready}
          placeholder={ready ? 'Type a message…' : 'Connecting…'}
          aria-label="Message"
          className="flex-1 h-9 px-3 py-2 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-1 focus:ring-offset-background disabled:opacity-50 transition-shadow"
        />
        <Button
          variant="primary"
          size="md"
          onClick={send}
          disabled={!ready || !draft.trim()}
          aria-label="Send message"
          className="shrink-0"
          style={
            /* override primary colour with the widget accent so the Send button
               matches the header — only if the accent differs from the default primary */
            accent !== '#1e40af' ? { background: accent, borderColor: accent } : undefined
          }
        >
          <Send className="h-4 w-4" aria-hidden="true" />
          <span className="sr-only">Send</span>
        </Button>
      </div>
    </div>
  );
}
