import { create } from 'zustand';

/**
 * Global open-state for the command palette (Cmd/Ctrl+K). Kept in a tiny store
 * (not React context) so any surface — the global key listener in
 * MarketingLayout and the search button in MarketingHeader — can open it
 * without prop-drilling or a shared provider.
 */
interface CommandPaletteState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteState>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
  toggle: () => set((s) => ({ open: !s.open })),
}));
