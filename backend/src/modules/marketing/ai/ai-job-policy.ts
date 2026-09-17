import {
  BadRequestException,
  ForbiddenException,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { Prisma } from "@prisma/client";
import { AI_CREDIT_COSTS } from "./ai-credit-costs";
import { ACTION_CATEGORY, spendAllowed } from "./ai-spend-policy";

export type AiJobProvider = "API" | "MCP" | "LOCAL";
export interface AiJobChoice {
  enabled?: boolean;
  provider?: AiJobProvider;
}
export interface AiJobDefinition {
  label: string;
  category: string;
  description: string;
  providers: AiJobProvider[];
}
const LABELS: Record<string, string> = {
  "conversation.reply": "Müşteri yanıtı",
  "conversation.followup": "Müşteri takip mesajı",
  "voice.copilot": "Canlı görüşme yardımcısı",
  "research.turn": "Araştırma akıl yürütmesi",
  "research.qualify": "Araştırma aday değerlendirmesi",
  "research.native_search": "Web arama servisi",
  "research.native_scrape": "Web sayfası okuma servisi",
  "content.compose": "Sosyal içerik metni",
  "content.concepts": "Video fikri ve sahne planı",
  "strategy.interview": "Strateji görüşmesi",
  "strategy.synthesize": "Strateji oluşturma",
  "strategy.turn": "Strateji değerlendirme turu",
  "brand.analyze": "Marka analizi",
  "ask_ai.question": "Panel asistanı isteği",
  "ask_ai.turn": "Panel asistanı yanıtı",
  "command.request": "Komut isteği",
  "command.turn": "Komut yürütme turu",
  "workflow.ai_generate": "Otomasyon metni",
  "workflow.ai_classify": "Metin sınıflandırma",
  "workflow.draft": "Otomasyon taslağı",
  "voice.turn": "Sesli asistan yanıtı",
  "voice.analysis": "Çağrı analizi",
  "stt.minute": "Konuşmayı yazıya çevirme",
  "review.reply_draft": "Yorum yanıtı",
  "funnel.draft": "Satış sayfası taslağı",
  "media.image.generate": "Görsel üretimi",
  "media.video.generate": "Video üretimi",
  "media.audio.generate": "Seslendirme ve müzik",
  "brand.safety": "İçerik güvenlik kontrolü",
  "social.publish.x": "X paylaşımı",
  "social.publish.x_link": "X bağlantılı paylaşımı",
};
const API_ONLY = new Set([
  "media.image.generate",
  "media.video.generate",
  "media.audio.generate",
  "social.publish.x",
  "social.publish.x_link",
  "research.native_search",
  "research.native_scrape",
]);
export const AI_JOBS: Record<string, AiJobDefinition> = Object.fromEntries(
  [...Object.keys(AI_CREDIT_COSTS), "media.audio.generate", "brand.safety"].map(
    (id) => [
      id,
      {
        label: LABELS[id] ?? id,
        category:
          ACTION_CATEGORY[id] ??
          (id === "brand.safety" ? "workflow" : "content"),
        description: API_ONLY.has(id)
          ? "Dış servis işlemi; Claude hesabıyla yönetilse de sağlayıcı ücreti ayrıca oluşur."
          : id === "stt.minute"
            ? "API veya yerel Whisper; yerel çalışma sunucu kaynağı kullanır."
            : id === "workflow.ai_classify"
              ? "API, bağlı Claude veya yerel çok dilli sınıflandırıcı."
              : "API veya MCP ile bağlı kendi Claude hesabınız. MCP seçimi ücretli API’ye otomatik geçmez.",
        providers: API_ONLY.has(id)
          ? ["API"]
          : id === "stt.minute"
            ? ["API", "LOCAL"]
            : id === "workflow.ai_classify"
              ? ["API", "MCP", "LOCAL"]
              : ["API", "MCP"],
      } satisfies AiJobDefinition,
    ],
  ),
);
// Entry fees are separate cost rows, but share the same runner as their loop.
// An explicitly configured row always wins over its sibling's inherited value.
export const RUNNER_SIBLINGS: Record<string, string> = Object.fromEntries(
  [
    ["ask_ai.question", "ask_ai.turn"],
    ["command.request", "command.turn"],
    ["research.qualify", "research.turn"],
    ["strategy.synthesize", "strategy.turn"],
  ].flatMap(([entry, turn]) => [
    [entry, turn],
    [turn, entry],
  ]),
);
export function jobPolicy(
  policy: Record<string, unknown> | null | undefined,
  action: string,
) {
  const jobs = policy?.jobs as Record<string, AiJobChoice> | undefined;
  const choice = jobs?.[action];
  const provider =
    choice?.provider ?? jobs?.[RUNNER_SIBLINGS[action]]?.provider;
  return {
    enabled: spendAllowed(policy, action),
    provider: provider ?? ("API" as AiJobProvider),
    explicit: !!provider,
  };
}
export function validateJobPatch(input: unknown): Record<string, AiJobChoice> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new BadRequestException("jobs must be an object");
  const result: Record<string, AiJobChoice> = {};
  for (const [id, raw] of Object.entries(input)) {
    const def = AI_JOBS[id];
    if (!def || !Object.prototype.hasOwnProperty.call(AI_JOBS, id))
      throw new BadRequestException(`Unknown AI job: ${id}`);
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new BadRequestException(`Invalid settings for ${id}`);
    const p = raw as Record<string, unknown>;
    if (
      Object.keys(p).some((k) => !["enabled", "provider"].includes(k)) ||
      ("enabled" in p && typeof p.enabled !== "boolean") ||
      ("provider" in p && !def.providers.includes(p.provider as AiJobProvider))
    )
      throw new BadRequestException(`Invalid settings for ${id}`);
    result[id] = { ...p };
  }
  return result;
}
export async function readJobPolicy(
  prisma: Pick<Prisma.TransactionClient, "workspace">,
  workspaceId: string,
  action: string,
) {
  const ws = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { aiSpendPolicy: true },
  });
  return jobPolicy(
    ws?.aiSpendPolicy as Record<string, unknown> | null | undefined,
    action,
  );
}
export async function assertJobProvider(
  prisma: Pick<Prisma.TransactionClient, "workspace">,
  workspaceId: string,
  action: string,
  provider?: AiJobProvider,
) {
  const decision = await readJobPolicy(prisma, workspaceId, action);
  if (!decision.enabled)
    throw new ForbiddenException({
      code: "AI_SPEND_DISABLED",
      action,
      message: `${AI_JOBS[action]?.label ?? action} kapalı.`,
    });
  if (
    AI_JOBS[action] &&
    !AI_JOBS[action].providers.includes(decision.provider)
  ) {
    throw new ServiceUnavailableException({
      code: "AI_PROVIDER_INVALID",
      action,
      message: "Bu iş için kayıtlı sağlayıcı desteklenmiyor; işlem yapılmadı.",
    });
  }
  if (provider && decision.provider !== provider)
    throw new ServiceUnavailableException({
      code: "AI_PROVIDER_REQUIRED",
      action,
      provider: decision.provider,
      message: `Bu iş ${decision.provider} için ayarlı; ücretli API’ye otomatik geçilmedi.`,
    });
  return decision;
}
