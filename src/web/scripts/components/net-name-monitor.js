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
//
// Reads the ONE shared NetlistCache every other consumer uses, rather than
// running its own independent buildNetlist() — that used to mean a held
// pushbutton's transient bridge (tracked only by the shared cache's
// #partStates, via chiphippo:part-state) could merge two named nets without
// this ever noticing, since it neither shared that state nor listened for the
// event at all.

export class NetNameMonitor {
  #netlist;
  #notifications;

  /**
   * @param {import('./netlist-cache.js').NetlistCache} netlistCache
   * @param {import('./notification-stack.js').NotificationStack} notifications
   */
  constructor(netlistCache, notifications) {
    this.#netlist = netlistCache;
    this.#notifications = notifications;
    window.addEventListener("chiphippo:doc-changed", () => this.check());
    window.addEventListener("chiphippo:part-state", () => this.check());
  }

  /** Toast every current name-merge conflict from the shared netlist. */
  check() {
    const { nameConflicts } = this.#netlist.get();
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
