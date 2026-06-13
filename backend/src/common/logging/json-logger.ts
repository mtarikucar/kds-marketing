import { ConsoleLogger, LoggerService, LogLevel } from '@nestjs/common';
import { getRequestId } from './request-context';

/**
 * Structured logger (Observability / Auditability) — backlog #1.
 *
 * Installed via `app.useLogger()` in `main.ts`, so EVERY `new Logger(context)`
 * call across the codebase (services, the HTTP access interceptor, the
 * exception filter) routes through here without any of them changing. Each line
 * becomes a single JSON object on stdout:
 *
 *   {"time":"…","level":"log","context":"HTTP","requestId":"…","message":"…"}
 *
 * so a log shipper can index by `requestId` and tie a support ticket's
 * `X-Request-ID` to every line that request produced — across services. The
 * `requestId` is pulled implicitly from the AsyncLocalStorage set by the
 * correlation middleware, so call sites stay oblivious.
 *
 * In a dev TTY (no `LOG_FORMAT=json`, not production) we defer to Nest's pretty
 * `ConsoleLogger` so local output stays readable; structured JSON is the
 * default in production where a collector parses it. KISS: no pino dependency —
 * a JSON line on stdout is all a 12-factor collector needs.
 */
export class JsonLogger extends ConsoleLogger implements LoggerService {
  private readonly json: boolean;

  constructor() {
    super();
    this.json =
      process.env.LOG_FORMAT === 'json' ||
      (process.env.NODE_ENV === 'production' &&
        process.env.LOG_FORMAT !== 'pretty');
  }

  log(message: unknown, context?: string): void {
    this.emit('log', message, context);
  }

  error(message: unknown, stackOrContext?: string, context?: string): void {
    // Nest calls error(message, stack?, context?). When only two args are
    // passed the second is the context, not a stack — match ConsoleLogger.
    if (context === undefined && this.isLikelyContext(stackOrContext)) {
      this.emit('error', message, stackOrContext);
    } else {
      this.emit('error', message, context, stackOrContext);
    }
  }

  warn(message: unknown, context?: string): void {
    this.emit('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.emit('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.emit('verbose', message, context);
  }

  private isLikelyContext(s?: string): boolean {
    // A stack trace spans multiple lines / contains "at "; a context is a short
    // single token. Heuristic mirrors Nest's own argument disambiguation.
    return !!s && !s.includes('\n') && s.length < 80;
  }

  private emit(
    level: LogLevel,
    message: unknown,
    context?: string,
    trace?: string,
  ): void {
    if (!this.json) {
      // Delegate to the pretty console logger for local dev ergonomics.
      (super[level] as (m: unknown, c?: string) => void).call(
        this,
        message,
        context,
      );
      if (trace && level === 'error') super.error(trace);
      return;
    }

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      context: context ?? undefined,
      requestId: getRequestId() ?? undefined,
      message:
        message instanceof Error ? message.message : (message as unknown),
    };
    if (trace) line.trace = trace;

    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(JSON.stringify(line) + '\n');
  }
}
