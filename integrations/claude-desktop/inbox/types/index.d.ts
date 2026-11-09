export type DeskCard = { id: string; bucket: string; title: string; why: string; url: string; isNew: boolean };
export type DeskView = { cards: DeskCard[]; status: string; error: string | null; busy: string | null };

declare module "claude-code" {
  interface PluginState {
    inbox: { view: DeskView };
  }
}
