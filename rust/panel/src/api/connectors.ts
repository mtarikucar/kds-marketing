import { request, seg } from './client';
import type {
  CapabilityOut,
  ConnectorHealth,
  CredentialInput,
  HooksOut,
  PendingAssetsOut,
  ProbeOut,
  SetCredentialsInput,
  StartOut,
} from './types';

// Connecting accounts (`/api/connectors`). Credentials and the provider's one-time code only ever
// travel in mutations, so none of them sits in the query cache. The webhook addresses
// (`connectorHooks`) are read by a query, but their URLs carry the workspace's hook tokens: the
// one panel that reads them (`WebhookPanel`) asks with `staleTime: 0, gcTime: 0`, so they are
// fetched afresh each time it shows and leave the cache as soon as it is gone.

/** `POST /api/connectors/oauth/start`: an OAuth flow for a Meta kind or `x`. */
export function startOAuth(kindKey: string): Promise<StartOut> {
  return request('POST', '/api/connectors/oauth/start', { body: { kind_key: kindKey } });
}

/**
 * `GET /api/connectors/oauth/callback/{meta|instagram|x}?state=&code=`: completes the flow the
 * provider called back for, at the segment of the app it signed in with (the server refuses any
 * other parameter, and a flow of another app) and answers the assets it found.
 */
export function completeOAuth(provider: string, state: string, code: string): Promise<PendingAssetsOut> {
  return request('GET', `/api/connectors/oauth/callback/${seg(provider)}`, { query: { state, code } });
}

/** `POST /api/connectors/oauth/{pending_id}/confirm`: the chosen assets become capabilities. */
export function confirmAssets(pendingId: string, selected: string[]): Promise<CapabilityOut[]> {
  return request('POST', `/api/connectors/oauth/${seg(pendingId)}/confirm`, { body: { selected } });
}

/** The credential exactly as the server reads it: its kind and fields, an optional one only when set. */
function credentialBody(credential: CredentialInput): Record<string, string | number> {
  switch (credential.kind) {
    case 'mailbox':
      return { kind: credential.kind, smtp_host: credential.smtp_host, smtp_port: credential.smtp_port,
        imap_host: credential.imap_host, imap_port: credential.imap_port, username: credential.username,
        password: credential.password, from_address: credential.from_address, tls: credential.tls };
    case 'netgsm_iys':
      return { kind: credential.kind, usercode: credential.usercode, password: credential.password, brand_code: credential.brand_code };
    case 'netgsm_sms':
      return {
        kind: credential.kind,
        usercode: credential.usercode,
        password: credential.password,
        msgheader: credential.msgheader,
      };
    case 'netgsm_pbx': {
      const body: Record<string, string> = {
        kind: credential.kind,
        username: credential.username,
        password: credential.password,
      };
      if (credential.trunk) body.trunk = credential.trunk;
      if (credential.pbxnum) body.pbxnum = credential.pbxnum;
      return body;
    }
    case 'meta_token':
      return { kind: credential.kind, access_token: credential.access_token };
  }
}

/**
 * `POST /api/connectors/credentials`: seals and probes the credentials; answers the capability.
 * The server refuses unknown fields, so only known ones are sent.
 */
export function setCredentials(input: SetCredentialsInput): Promise<CapabilityOut> {
  const body: Record<string, unknown> =
    'capability_id' in input
      ? { capability_id: input.capability_id }
      : { kind_key: input.kind_key, name: input.name };
  if (input.external_id) body.external_id = input.external_id;
  body.credential = credentialBody(input.credential);
  return request('POST', '/api/connectors/credentials', { body });
}

/** `POST /api/connectors/{id}/probe`: the probe's outcome and the status after it. */
export function probeConnector(id: string): Promise<ProbeOut> {
  return request('POST', `/api/connectors/${seg(id)}/probe`);
}

/** `GET /api/connectors/health`: every connector capability that is not retired. */
export function connectorHealth(): Promise<ConnectorHealth[]> {
  return request('GET', '/api/connectors/health');
}

/** `POST /api/connectors/{id}/reconnect`: a flow bound to the capability, as `startOAuth` answers. */
export function reconnectConnector(id: string): Promise<StartOut> {
  return request('POST', `/api/connectors/${seg(id)}/reconnect`);
}

/**
 * `GET /api/connectors/hooks`: the webhook addresses to register at the providers. The NetGSM ones
 * carry the workspace's hook tokens; the server answers only `capabilities.manage`.
 */
export function connectorHooks(signal?: AbortSignal): Promise<HooksOut> {
  return request('GET', '/api/connectors/hooks', { signal });
}
