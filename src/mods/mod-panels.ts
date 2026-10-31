import type { ModOwner, ModPanel, ModPanelRender } from "@/mods/types";

export function validateModPanelId(id: string): void {
  if (!id.trim()) {
    throw new Error("Mod panel id must not be empty");
  }
}

export function getModPanelKey(modPath: string, id: string): string {
  return JSON.stringify([modPath, id]);
}

export function upsertModPanel(
  registry: { ui: { panels: Record<string, ModPanel> } },
  owner: ModOwner,
  id: string,
  patch: { render?: ModPanelRender; order?: number },
): void {
  validateModPanelId(id);
  const panelKey = getModPanelKey(owner.id, id);
  const existing = registry.ui.panels[panelKey];
  const render = patch.render ?? existing?.render;
  if (!render) return;
  registry.ui.panels[panelKey] = {
    render,
    id,
    owner,
    order: patch.order ?? existing?.order ?? 100,
    path: owner.path,
    updatedAt: Date.now(),
  };
}
