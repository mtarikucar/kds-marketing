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
    // Nest calls error(message, stack?, context?). With only two args the
    // second is the bound CONTEXT for the common `logger.error('msg')` case
    // (the Logger wrapper appends its context), but a context-less caller may
    // pass a stack there instead. Disambiguate conservatively: only treat it as
    // context when it looks like a context identifier; otherwise keep it as the
    // trace so a 5xx stack is never silently dropped.
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

  fatal(message: unknown, context?: string): void {
    // ConsoleLogger gained fatal(); route it through JSON too so a fatal isn't
    // silently emitted in the pretty format while everything else is JSON.
    this.emit('fatal' as LogLevel, message, context);
  }

  private isLikelyContext(s?: string): boolean {
    // A context is a short single token (e.g. 'PrismaService'); a stack trace
    // contains whitespace ("    at …") and usually newlines, and an error
    // message stringified from a non-Error throw is rarely a bare identifier.
    // Requiring NO whitespace keeps stacks/messages out of the context slot
    // (preserved as `trace`) while still recognizing real context labels.
    return !!s && !/\s/.test(s) && s.length <= 40;
  }

  private emit(
    level: LogLevel,
    message: unknown,
    context?: string,
    trace?: string,
  ): void {
    if (!this.json) {
      // Delegate to the pretty console logger for local dev ergonomics.
      const fn = (super[level as keyof ConsoleLogger] ?? super.log) as (
        m: unknown,
        c?: string,
      ) => void;
      fn.call(this, message, context);
      if (trace && (level === 'error' || (level as string) === 'fatal')) {
        super.error(trace);
      }
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

    const stream =
      level === 'error' || level === 'warn' || (level as string) === 'fatal'
        ? process.stderr
        : process.stdout;
    // A logger must be infallible: never let a circular/BigInt message throw
    // back into the (often already error-handling) caller.
    stream.write(this.safeStringify(line) + '\n');
  }

  private safeStringify(line: Record<string, unknown>): string {
    try {
      return JSON.stringify(line, bigIntReplacer);
    } catch {
      // Last resort: drop the un-serializable message but keep the envelope so
      // the line (level/context/requestId) is still indexable.
      return JSON.stringify({
        ...line,
        message: '[unserializable message]',
      });
    }
  }
}

/** Make BigInt JSON-safe (JSON.stringify throws on BigInt by default). */
function bigIntReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value;
}
