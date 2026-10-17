/**
 * Disclosure text for the hooks consent gate. Both surfaces show the SAME
 * in-app ask: the server ships these strings in the `hooksConsentRequest`
 * message and the webview's IntroBubble (the greeter character's speech
 * bubble) renders them verbatim on the Intro's consent step, so there is
 * exactly one copy of the terms and no client-side duplicate to drift into
 * asking for approval on weaker terms.
 *
 * Two pieces: the HEADLINE is the title of the Intro's consent step and the
 * DISCLOSURE is that step's body. The headline carries NO disclosure facts —
 * every fact lives in the shared disclosure block, so no fact depends on how a
 * surface renders its title slot (consentCopy.test.ts pins that split).
 *
 * The event count is interpolated from CLAUDE_HOOK_EVENTS, never written out:
 * a hardcoded number silently becomes a lie the next time the list changes.
 */

import { CLAUDE_HOOK_EVENTS, SETTINGS_BACKUP_SUFFIX } from './constants.js';

const SETTINGS_FILE = '~/.claude/settings.json';

/** WHY we ask + WHAT we write. */
export const CONSENT_FACT_WHAT =
  `Để đưa agent của bạn hoạt động theo thời gian thực, Pixel Agents thêm hook cho ` +
  `${CLAUDE_HOOK_EVENTS.length} sự kiện Claude Code vào ${SETTINGS_FILE}. ` +
  `Lưu ý rằng cài đặt hiện có của bạn được giữ nguyên, và một bản sao lưu một lần được lưu thành settings.json${SETTINGS_BACKUP_SUFFIX}.`;

/** WHAT data moves, and where it stops.
 *
 *  "Nothing leaves your machine" is not something this prompt can promise:
 *  `npx pixel-agents --host 0.0.0.0` binds the same server to every interface,
 *  and an accepted socket receives the store broadcasts
 *  (server/src/httpServer.ts). So it states the default and names the one
 *  thing that changes it, rather than making a promise the software can be
 *  asked to break. */
export const CONSENT_FACT_DATA =
  'Claude Code sẽ gửi những sự kiện đó - gồm cả tên công cụ và đầu vào của công cụ - tới một ' +
  'máy chủ Pixel Agents trên máy này. Mọi thứ đều ở lại cục bộ - máy chủ chỉ lắng nghe trên 127.0.0.1 - trừ khi ' +
  'bạn chủ động khởi chạy nó với --host để mở nó ra trong mạng của bạn.';

/** HOW to undo it. */
export const CONSENT_FACT_REVERSIBLE =
  'Bạn có thể gỡ các hook bất cứ lúc nào trong Cài đặt → Phát hiện tức thì (Hooks).';

/** Headline for the first-run gate — the only population that is asked. A user
 *  whose hooks a pre-consent version already installed is migrated silently
 *  (the migration only ever drops events), so there is no second headline.
 *  Title of the Intro's consent step ("Welcome to Pixel Agents!" is the
 *  Intro's own opening-step title, owned by the webview). Carries NO
 *  disclosure facts by design: the facts all live in CONSENT_DISCLOSURE. */
export const CONSENT_INSTALL_HEADLINE = 'Một điều nữa: hook!';

/** The three disclosure facts, in order, as one block.
 *
 *  This is the consent step's body. The IntroBubble splits it on the blank
 *  lines and renders every paragraph in full on the decision surface itself — no
 *  "Details" affordance, which would put the disclosure one click away from
 *  the decision it is there to inform. */
export const CONSENT_DISCLOSURE = [
  CONSENT_FACT_WHAT,
  CONSENT_FACT_DATA,
  CONSENT_FACT_REVERSIBLE,
].join('\n\n');
