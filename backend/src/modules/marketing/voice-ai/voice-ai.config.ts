/** Voice-AI feature gates. Everything inert until the operator sets the env. */
export function isSttConfigured(): boolean {
  return !!process.env.STT_PROVIDER?.trim() && !!process.env.STT_API_KEY?.trim();
}
/** Custom-LLM bridge (VAPI/Retell/ElevenLabs → our Claude). */
export function isVoiceBridgeConfigured(): boolean {
  return !!process.env.VOICE_AI_BRIDGE_SECRET?.trim();
}
/** NetGSM Özel-API inbound IVR webhook. */
export function isNetgsmIvrConfigured(): boolean {
  return !!process.env.NETGSM_IVR_TOKEN?.trim();
}
/** Copilot only needs STT (browser provides audio); no extra purchase. */
export function isCopilotConfigured(): boolean {
  return isSttConfigured();
}
export interface VoiceAiPublicStatus { stt: boolean; bridge: boolean; netgsmIvr: boolean; copilot: boolean; }
export function voiceAiPublicStatus(): VoiceAiPublicStatus {
  return { stt: isSttConfigured(), bridge: isVoiceBridgeConfigured(), netgsmIvr: isNetgsmIvrConfigured(), copilot: isCopilotConfigured() };
}
