export type HudSkill = string | null

declare module 'claude-code' {
  interface PluginState {
    cclitehud: {
      skill: HudSkill
      cachePct: number | null
      tick: number
    }
  }
}
