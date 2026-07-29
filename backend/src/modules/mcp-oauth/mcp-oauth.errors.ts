import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * The RFC 6749 error envelope.
 *
 * OAuth clients parse `{"error": "...", "error_description": "..."}` — the
 * machine-readable `error` code is what drives their recovery (re-run the
 * authorization flow on `invalid_grant`, step up on `insufficient_scope`, give
 * up on `invalid_client`). Nest's default `BadRequestException` body is
 * `{statusCode, message, error: "Bad Request"}`, whose `error` is an HTTP
 * reason phrase, NOT an OAuth code — a client reading it sees garbage and
 * cannot recover. Hence this envelope on every OAuth endpoint.
 *
 * `AllExceptionsFilter` spreads an object response, so the two required members
 * survive verbatim (it only ADDS `requestId`/`path`/`timestamp`, and RFC 6749
 * §5.2 clients ignore unrecognised members).
 */
export type OAuthErrorCodeString =
  // RFC 6749 §4.1.2.1 / §5.2
  | 'invalid_request'
  | 'invalid_client'
  | 'invalid_grant'
  | 'unauthorized_client'
  | 'unsupported_grant_type'
  | 'unsupported_response_type'
  | 'invalid_scope'
  | 'access_denied'
  | 'server_error'
  // RFC 8707 §2 — the requested `resource` is not one we serve.
  | 'invalid_target'
  // RFC 6750 §3.1 — resource-server errors.
  | 'invalid_token'
  | 'insufficient_scope';

export class OAuthHttpException extends HttpException {
  constructor(
    readonly oauthError: OAuthErrorCodeString,
    description: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
  ) {
    super({ error: oauthError, error_description: description }, status);
    this.name = 'OAuthHttpException';
  }
}
