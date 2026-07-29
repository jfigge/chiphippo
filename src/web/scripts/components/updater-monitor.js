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

// updater-monitor.js — turns the auto-updater's `chiphippo:updater-*`
// broadcasts into toasts (Feature 280). The always-on surface, alive for the
// whole session;
// Settings ▸ About owns the inline status line, which only exists while that
// dialog is open. Same shape as net-name-monitor.js: it listens to global
// events and pushes to the shared NotificationStack, and owns nothing else.
//
// WHAT IT DOES NOT SAY IS THE POINT. A STARTUP check is silent unless it found
// something — "you're up to date" is an answer to a question the user asked,
// and unasked it is a nag; an error nobody could act on is worse. So the
// up-to-date and failure toasts fire only when `manual` is set, which is main's
// record of whether a human pressed the button. There is deliberately no
// download-progress toast either: milestones are what a corner of the desk can
// usefully carry.

/** The one key every updater toast uses — see UpdaterMonitor#show. */
const TOAST_KEY = "updater";

export class UpdaterMonitor {
  #notifications;

  /**
   * @param {import('./notification-stack.js').NotificationStack} notifications
   */
  constructor(notifications) {
    this.#notifications = notifications;

    window.addEventListener("chiphippo:updater-available", (e) => {
      const version = e.detail?.version;
      this.#show({
        variant: "info",
        title: "Update available",
        message: version
          ? `Downloading ${version} in the background…`
          : "Downloading the update in the background…",
      });
    });

    // The one toast that OFFERS something, so it carries the Restart button —
    // and it is sticky, because an update that finished downloading while the
    // user was wiring something must still be there when they look up. It
    // needs no deadline either way: declining costs nothing, since an
    // installed-on-quit update lands the next time the app is closed.
    window.addEventListener("chiphippo:updater-downloaded", (e) => {
      const version = e.detail?.version;
      this.#show({
        variant: "info",
        sticky: true,
        title: "Update ready",
        message: version
          ? `Version ${version} has been downloaded.`
          : "The update has been downloaded.",
        actionLabel: "Restart",
        onAction: () => window.chiphippo?.updater?.install?.(),
      });
    });

    window.addEventListener("chiphippo:updater-not-available", (e) => {
      // A dev or store build reports itself in Settings ▸ About, where the
      // answer makes sense beside the version it is about; a toast over the
      // desk saying "not from here" explains nothing — hence `reason`, which
      // is present only for those two.
      if (!e.detail?.manual || e.detail?.reason) return;
      this.#show({
        variant: "info",
        title: "Up to date",
        message: "You're running the latest version of Chip Hippo.",
      });
    });

    window.addEventListener("chiphippo:updater-error", (e) => {
      if (!e.detail?.manual) return;
      this.#show({
        variant: "warning",
        title: "Update check failed",
        message: "Could not check for updates. Please try again later.",
      });
    });
  }

  /**
   * Show a toast that REPLACES whatever the updater last said.
   *
   * An update announces itself in stages — downloading, then ready — and they
   * are one running commentary, not four independent warnings, so they must
   * not stack up in the corner. One shared key does that, but the stack's
   * de-dupe deliberately keeps the FIRST toast's content and only refreshes its
   * timer (that is what makes a standing sim warning stable while it re-settles
   * every tick), which here would freeze the message at "Downloading…" forever.
   * So the old one is dismissed first: same slot, current wording.
   */
  #show(opts) {
    this.#notifications.dismiss(TOAST_KEY);
    this.#notifications.notify({ key: TOAST_KEY, ...opts });
  }
}
