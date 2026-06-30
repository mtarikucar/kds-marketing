export interface MediaGenSubmit {
  type: 'IMAGE' | 'VIDEO';
  model: string;
  prompt: string;
  negativePrompt?: string;
  aspectRatio?: string;
  durationSec?: number;
  referenceImageUrls?: string[];
  seed?: number;
  webhookUrl?: string;
}

export interface MediaGenOutput {
  url: string;
  mime: string;
  width?: number;
  height?: number;
  durationSec?: number;
}

export type MediaGenStatus = 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED' | 'BLOCKED';

export interface MediaGenResult {
  status: MediaGenStatus;
  outputs?: MediaGenOutput[];
  error?: string;
}

export interface MediaProvider {
  readonly name: string;
  isConfigured(): boolean;
  submit(opts: MediaGenSubmit): Promise<{ providerRequestId: string }>;
  getResult(requestId: string, model: string): Promise<MediaGenResult>;
}

export const MEDIA_PROVIDER = 'MEDIA_PROVIDER';
