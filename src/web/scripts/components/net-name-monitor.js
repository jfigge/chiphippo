/*
 * Copyright 2026 Jason Figge
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// net-name-monitor.js — watches for net-name MERGE conflicts (Feature 120) and
// surfaces them in the notification stack. Two names bind to member addresses;
// a later edit (a new wire) can merge their nets, and then both names point at
// one net. The netlist reports the loser deterministically; this routes it to
// a toast so a name is never silently dropped. Naming stays inert to the
// engine — this only reads the netlist partition, never changes it.

import { buildNetlist } from "../sim/netlist.js";

export class NetNameMonitor {
  #doc;
  #notifications;

  /**
   * @param {import('../model/desk-doc.js').DeskDoc} deskDoc
   * @param {import('./notification-stack.js').NotificationStack} notifications
   */
  constructor(deskDoc, notifications) {
    this.#doc = deskDoc;
    this.#notifications = notifications;
    window.addEventListener("chiphippo:doc-changed", () => this.check());
  }

  /** Rebuild the netlist and toast every current name-merge conflict. */
  check() {
    const { nameConflicts } = buildNetlist(this.#doc.toJSON());
    for (const c of nameConflicts) {
      this.#notifications.notify({
        // Keyed on the net so a re-settle refreshes rather than stacks.
        key: `netname-conflict:${c.netId}`,
        variant: "warning",
        title: "Net name conflict",
        message: `"${c.winner}" and "${c.name}" name the same net — using "${c.winner}".`,
      });
    }
  }
}
