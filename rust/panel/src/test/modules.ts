import type { ModulesOut } from '@/api/modules';

export const legacyModules: ModulesOut = {
  modules: [
    ['inbox', 'Gelen kutusu'], ['strategy', 'Strateji'], ['content', 'İçerik oluşturma'], ['social', 'Sosyal medya yönetimi'], ['ads', 'Reklam yönetimi'], ['materials', 'Materyal kütüphanesi'],
    ['people', 'Kişiler'], ['prospects', 'Aday havuzu'], ['outreach', 'Kampanyalar'], ['calls', 'Aramalar'],
  ].map(([id, name]) => ({
    blueprint: { id, name, description: '', version: '1', requirements: [], workflow: [], builtin: true },
    required: id === 'strategy', installed: true,
    config: { brief: '', agent_ids: [], capability_ids: [] }, revision: 1,
  })),
  catalog: [],
};

export const coreModules: ModulesOut = {
  ...legacyModules,
  modules: legacyModules.modules.map(m => ({ ...m, installed: m.required })),
};
