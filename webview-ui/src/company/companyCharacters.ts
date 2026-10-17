/**
 * companyCharacters: Company sessions as office characters.
 *
 * A company character is a VIEW of one Company session and nothing else. It is
 * deliberately NOT a Claude agent:
 *
 *  - It is never registered in the server's AgentStateStore, so the Claude
 *    scanners (transcript polling, external adoption, the stale check) cannot
 *    see it, nothing is persisted for it, and the stale check cannot kill it.
 *  - It has no terminal behind it. A click therefore must NOT send `focusAgent`
 *    — there is no window to raise — it selects the company session instead
 *    (see `selection.ts`).
 *  - Its identity is a LOCAL number in the office's own id space. The session
 *    owns the durable id (`sessionId`); the character id is a rendering detail
 *    of this webview instance, which is why the map lives here and is rebuilt
 *    from the snapshot after a reload rather than written back to the server.
 *
 * The mapping is `sessionId -> characterId`, stable for the life of the client:
 * the same session always resolves to the same character, so a card click, a
 * character click and the camera all agree, and a re-sync of an unchanged
 * snapshot adds nothing.
 *
 * Visibility follows the session's OWN status, because the office is a map of
 * what the company still holds. A parked session stays in the office — parked
 * is a recoverable state with its history intact, and the plan calls for it to
 * be visibly parked. A session that was killed or archived has left the pool;
 * its character goes with it.
 */

import type { OfficeState } from '../office/engine/officeState.js';
import { getLoadedCharacterCount } from '../office/sprites/spriteData.js';
import type { CompanyViewState, SessionView } from './companyState.js';
import { COMPANY_CHARACTER_ID_BASE } from './constants.js';
import { COMPANY_ROLES, ROLE_LABELS } from './roleProfiles.js';

/** Statuses whose session no longer holds a character in the office. */
const LEFT_THE_OFFICE: Record<string, true> = { stopped: true, archived: true };

/**
 * Whether a session's character is doing work right now.
 *
 * `busy` IS work, task or not: a Director planning a Contract and an Advisor
 * reviewing a draft both run the model before any task exists, and drawing
 * them as idle while a real generation is in flight is the wrong picture.
 * `starting` is work only once a task is actually attached — a session still
 * bootstrapping its process is idle, not typing. Everything else (parked with
 * no live process, paused, crashed, waiting on the user) is idle at its desk.
 */
function isWorkingSession(session: SessionView): boolean {
  if (session.status === 'busy') return true;
  return session.status === 'starting' && session.activeTaskId !== undefined;
}

/**
 * The tool a role is drawn typing with.
 *
 * The office animates a writing tool differently from a reading one, and this
 * is how a company employee looks busy without inventing a tool call: it is the
 * role's own nature (a Worker edits, a QA run executes, everyone else reads),
 * not a name scraped out of a transcript. No protocol field carries it and no
 * `agentToolStart` is fabricated for it.
 */
const ROLE_TOOL: Record<string, string> = {
  worker: 'Write',
  qa: 'Bash',
  advisor: 'Read',
  director: 'Read',
  judge: 'Read',
};

/**
 * Whether a session should have a character right now.
 *
 * `crashed` and `paused` are deliberately visible: both are states the user
 * has to SEE to act on them (restart from the drawer), and a crash that made
 * its character vanish would look like the work never happened.
 */
export function companySessionVisible(status: string): boolean {
  return !LEFT_THE_OFFICE[status];
}

/** Company role as the office shows it — company vocabulary, never Claude's. */
export function companyRoleLabel(role: string): string {
  return ROLE_LABELS[role as keyof typeof ROLE_LABELS] ?? role;
}

/**
 * A palette per role, so a director looks like the director on every reload
 * rather than drawing a new random skin each time the panel is restored.
 * Deterministic, and it never reaches into OfficeState's diverse-palette logic
 * (which is about filling the six skins for an unbounded set of agents).
 */
function rolePalette(role: string): { palette: number; hueShift: number } {
  const count = getLoadedCharacterCount();
  if (count <= 0) return { palette: 0, hueShift: 0 };
  const index = COMPANY_ROLES.indexOf(role as (typeof COMPANY_ROLES)[number]);
  // An unknown role still needs a distinct-ish slot rather than always 0.
  const slot = index >= 0 ? index : COMPANY_ROLES.length;
  return { palette: slot % count, hueShift: 0 };
}

/**
 * Where each role works.
 *
 * These are Area labels in the office layout, not folder names: a Company
 * character belongs to its department rather than to whichever workspace folder
 * happens to own it. A role missing here simply falls back to the normal seat
 * picker, so an unrecognised role is never stuck without a desk.
 */
const ROLE_AREAS: Record<string, readonly string[]> = {
  director: ['meeting'],
  advisor: ['meeting'],
  worker: ['desk'],
  qa: ['desk'],
  judge: ['desk'],
};

export function companyRoleAreas(role: string): readonly string[] | undefined {
  return ROLE_AREAS[role];
}

export interface CompanyCharacterSync {
  /** Session ids that gained a character in this pass. */
  added: string[];
  /** Session ids whose character was retired in this pass. */
  removed: string[];
}

export class CompanyCharacterLayer {
  /** companySessionId -> office character id */
  private readonly bySession = new Map<string, number>();
  /** office character id -> companySessionId */
  private readonly byCharacter = new Map<number, string>();
  private nextId = COMPANY_CHARACTER_ID_BASE;
  /**
   * The first sync of a client lifetime is a RESTORE, not a spawn: the
   * characters are already working, so they appear rather than raining in.
   */
  private restored = false;

  characterId(sessionId: string): number | null {
    return this.bySession.get(sessionId) ?? null;
  }

  sessionIdFor(characterId: number): string | null {
    return this.byCharacter.get(characterId) ?? null;
  }

  /** The characters currently on the office floor, oldest session first. */
  mappedCharacters(): { sessionId: string; characterId: number }[] {
    return [...this.bySession.entries()].map(([sessionId, characterId]) => ({
      sessionId,
      characterId,
    }));
  }

  /** Sessions the snapshot says should be standing in the office. */
  visibleSessions(state: CompanyViewState): SessionView[] {
    return Object.values(state.sessions)
      .filter((session) => companySessionVisible(session.status))
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Bring the office in line with the snapshot.
   *
   * Only safe once the layout has loaded: seats come from the layout, and a
   * character added before that would spawn on a bare grid and be re-seated by
   * a later rebuild. The caller gates on that (App passes `layoutReady`).
   */
  sync(state: CompanyViewState, office: OfficeState): CompanyCharacterSync {
    const wanted = new Map<string, SessionView>();
    for (const session of this.visibleSessions(state)) wanted.set(session.id, session);

    const added: string[] = [];
    const removed: string[] = [];

    for (const [sessionId, characterId] of [...this.bySession]) {
      if (wanted.has(sessionId)) continue;
      this.bySession.delete(sessionId);
      this.byCharacter.delete(characterId);
      office.removeAgent(characterId);
      removed.push(sessionId);
    }

    const skipSpawnEffect = !this.restored;
    for (const [sessionId, session] of wanted) {
      const existing = this.bySession.get(sessionId);
      if (existing !== undefined) {
        // The character can go missing without the session changing — a layout
        // rebuild clears and re-seats, and a despawn effect completes. Restore
        // the character rather than leaving a live session invisible.
        if (!office.characters.has(existing)) {
          this.place(session, office, skipSpawnEffect);
          continue;
        }
        this.applyActivity(office, existing, session);
        continue;
      }
      const characterId = this.allocate(office);
      this.bySession.set(sessionId, characterId);
      this.byCharacter.set(characterId, sessionId);
      this.place(session, office, skipSpawnEffect, characterId);
      added.push(sessionId);
    }

    this.restored = true;
    return { added, removed };
  }

  /** Forget every mapping — the snapshot went away entirely. */
  reset(): void {
    this.bySession.clear();
    this.byCharacter.clear();
    this.restored = false;
  }

  private place(
    session: SessionView,
    office: OfficeState,
    skipSpawnEffect: boolean,
    characterId?: number,
  ): void {
    const id = characterId ?? this.bySession.get(session.id);
    if (id === undefined) return;
    const { palette, hueShift } = rolePalette(session.role);
    // Seated by department: the area is resolved during creation, so it has to
    // reach addAgent rather than being stamped on afterwards.
    office.addAgent(
      id,
      palette,
      hueShift,
      undefined,
      skipSpawnEffect,
      undefined,
      undefined,
      companyRoleAreas(session.role),
    );
    const character = office.characters.get(id);
    if (character) character.companySessionId = session.id;
    this.applyActivity(office, id, session);
  }

  /**
   * Drive the character's animation from the session's own state.
   *
   * A working session types with the tool its role implies; everything else —
   * parked with no live process behind it, paused, crashed, waiting on the user
   * — sits idle at its desk (see `isWorkingSession`). Both are applied through
   * OfficeState's own API (the same calls `useExtensionMessages` makes for a
   * real agent), so furniture auto-state, the seat-rest timer and the FSM all
   * behave exactly as they do for a Claude agent. No `agentToolStart` is
   * fabricated: the animation is derived, never reported.
   *
   * It runs on EVERY sync, including one where no character was added or
   * removed, because a session that started or finished a task changes only
   * its status — the character mapping is identical.
   */
  private applyActivity(office: OfficeState, characterId: number, session: SessionView): void {
    const character = office.characters.get(characterId);
    if (!character) return;
    const working = isWorkingSession(session);
    const tool = working ? (ROLE_TOOL[session.role] ?? 'Write') : null;
    if (character.currentTool !== tool) office.setAgentTool(characterId, tool);
    if (character.isActive !== working) office.setAgentActive(characterId, working);
  }

  private allocate(office: OfficeState): number {
    // The range is ours, but the office is the single source of truth about
    // what already exists: skip any id that is somehow taken rather than
    // drawing two characters on one seat.
    while (office.characters.has(this.nextId)) this.nextId -= 1;
    const id = this.nextId;
    this.nextId -= 1;
    return id;
  }
}
